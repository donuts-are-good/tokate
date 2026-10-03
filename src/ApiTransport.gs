package Tokate

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.Text.Json

internal class ApiResponse {
    internal var Status int32
    internal var Body string = ""
    internal var ETag string = ""
    internal var RetryAfter string = ""
    internal var Remaining string = ""
    internal var Reset string = ""
    internal var Date string = ""
    internal var PollInterval string = ""

    internal init(output string) {
        let normalized = output.Replace("\r\n", "\n")
        let end = normalized.IndexOf("\n\n", StringComparison.Ordinal)
        if end < 0 {
            return
        }
        let lines = normalized.Substring(0, end).Split('\n')
        let status = lines[0].Split(' ', StringSplitOptions.RemoveEmptyEntries)
        if status.Length < 2 || !status[0].StartsWith("HTTP/") || !Int32.TryParse(status[1], out Status) ||
            Status < 100 ||
            Status > 599 {
            Status = 0
            return
        }
        for i in 1 ... lines.Length {
            let colon = lines[i].IndexOf(':')
            if colon < 1 {
                continue
            }
            let name = lines[i].Substring(0, colon).ToLowerInvariant()
            if name != "etag" &&
                name != "retry-after" &&
                name != "x-ratelimit-remaining" &&
                name != "x-ratelimit-reset" &&
                name != "date" &&
                name != "x-poll-interval" {
                continue
            }
            let value = lines[i].Substring(colon + 1).Trim()
            switch name {
                case "etag" {
                    ETag = value
                }
                case "retry-after" {
                    RetryAfter = value
                }
                case "x-ratelimit-remaining" {
                    Remaining = value
                }
                case "x-ratelimit-reset" {
                    Reset = value
                }
                case "date" {
                    Date = value
                }
                case "x-poll-interval" {
                    PollInterval = value
                }
            }
        }
        Body = normalized.Substring(end + 2)
    }

    internal func RateLimited() bool {
        if Status == 429 {
            return true
        }
        if Status != 403 {
            return false
        }
        if RetryAfter != "" || Remaining == "0" {
            return true
        }
        try {
            let message = J.Text(J.Parse(Body), "message").ToLowerInvariant()
            return message.Contains("rate limit") || message.Contains("abuse detection")
        } catch {
            return false
        }
    }

    internal func Delay(rateLimited bool) double {
        let now = DateTimeOffset.UtcNow
        var date DateTimeOffset
        let server = DateTimeOffset.TryParse(
            Date,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal,
            out date
        ) ? date: now
        var delay double
        var seconds double
        var supplied bool
        if Double.TryParse(RetryAfter, NumberStyles.None, CultureInfo.InvariantCulture, out seconds) && Double.IsFinite(
            seconds
        ) &&
            seconds >= 0 {
            delay = seconds
            supplied = true
        } else if DateTimeOffset.TryParse(
            RetryAfter,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal,
            out date
        ) {
            delay = Math.Max(0.0, (date - server).TotalSeconds)
            supplied = true
        }
        var reset int64
        if Remaining == "0" && Int64.TryParse(Reset, out reset) && reset >= 0 && reset <= 253402300799 {
            delay = Math.Max(delay, Math.Max(0.0, (DateTimeOffset.FromUnixTimeSeconds(reset) - server).TotalSeconds))
            supplied = true
        }
        if rateLimited && !supplied {
            delay = 60.0
        }
        return delay
    }
}

internal class ApiCache {
    internal var ETag string = ""
    internal var Body JsonElement
}

internal class ApiTransport {
    shared {
        private let Cache Dictionary[string, ApiCache] = Dictionary[string, ApiCache]()
        private let Clock Stopwatch = Stopwatch.StartNew()
        private var NextMutation double
        private var Reads int32
        private var Mutations int32
        private var ConditionalResponses int32
        private var Retries int32

        internal func Report() {
            Console.Error.WriteLine(
                "Tokate API traffic: " + J.Write(
                    J.Map(
                        "reads",
                        Reads,
                        "mutations",
                        Mutations,
                        "conditional_responses",
                        ConditionalResponses,
                        "retry_attempts",
                        Retries
                    )
                )
            )
            Console.Error.WriteLine(
                "Counts measure Tokate gh-api operations; exclude unseen GitHub CLI/Git requests and workflow executions."
            )
        }

        private func Wait(seconds double) {
            if seconds > 0 {
                select {
                    case <- after(TimeSpan.FromSeconds(seconds)) { }
                }
            }
        }

        private func ValidETag(value string) bool {
            let start = value.StartsWith("W/", StringComparison.Ordinal) ? 2: 0
            if value.Length < start +
                2 ||
                value.Length > 1024 ||
                value[start] != '"' ||
                value[value.Length - 1] != '"' {
                return false
            }
            for i in start + 1 ... value.Length - 1 {
                let character = value[i]
                if character < '!' || character > '~' || character == '"' {
                    return false
                }
            }
            return true
        }

        private func WeakETagMatch(left string, right string) bool {
            if !ValidETag(left) || !ValidETag(right) {
                return false
            }
            return String.Equals(
                left.StartsWith("W/", StringComparison.Ordinal) ? left.Substring(2): left,
                right.StartsWith("W/", StringComparison.Ordinal) ? right.Substring(2): right,
                StringComparison.Ordinal
            )
        }

        private func Failure(status int32, read bool, delay double) Exception {
            let reason = status == 0 ? "transport failure or missing response status": "HTTP " + status.ToString()
            var message = "GitHub " + (read ? "read": "mutation") + " failed (" + reason + "). "
            message += read ? "At most three attempts within 60 seconds are allowed.":
            "No automatic retry was made. The outcome may be uncertain; inspect remote state before retrying. For publication, use tokate publish --run with the saved run."
            if delay > 0 {
                let bounded = Math.Min(delay, (DateTimeOffset.MaxValue - DateTimeOffset.UtcNow).TotalSeconds - 1.0)
                message += " Retry at or after " +
                    DateTimeOffset
                    .UtcNow
                    .AddSeconds(bounded)
                    .ToString("u", CultureInfo.InvariantCulture) +
                    " (in " +
                    Math
                    .Ceiling(delay).ToString(CultureInfo.InvariantCulture) + " seconds)."
            }
            return Exception(message)
        }

        internal suspend func Request(
            path string,
            body Object?,
            method string,
            missing bool,
            expires int64 = 0
        ) JsonElement {
            let timer = Stopwatch.StartNew()
            let verb = (method == "" ? (body == nil ? "GET": "POST"): method).ToUpperInvariant()
            let read = verb == "GET"
            let input string? = body == nil ? nil: J.Write(body)
            let key = path + "\n" + input
            for attempt in 0 ... (read ? 3: 1) {
                if !read {
                    while Clock.Elapsed.TotalSeconds < NextMutation {
                        Wait(NextMutation - Clock.Elapsed.TotalSeconds)
                    }
                }
                var remaining = 60.0 - timer.Elapsed.TotalSeconds
                if !read && expires > 0 {
                    remaining = Math.Min(remaining, expires - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0)
                    if remaining <= 0 {
                        throw Exception("Reservation expired before coordination mutation")
                    }
                }
                if remaining <= 0 {
                    throw Failure(0, read, 0.0)
                }
                let args = List[string]{"api", "--include", "--hostname", "github.com", "--method", verb, path}
                var cached ApiCache
                let conditional = read && Cache.TryGetValue(key, out cached)
                if conditional {
                    args.Add("-H")
                    args.Add("If-None-Match: " + cached.ETag)
                }
                if body != nil {
                    args.Add("--input")
                    args.Add("-")
                }
                if read {
                    Reads++
                    if attempt > 0 {
                        Retries++
                    }
                } else {
                    Mutations++
                }
                var result CommandResult = CommandResult{Code: 1}
                try {
                    result = Commands.Run(
                        "gh",
                        args.ToArray(),
                        input: input,
                        github: true,
                        milliseconds: Math.Max(1, Convert.ToInt32(Math.Floor(remaining * 1000.0)))
                    )
                } catch { }
                if !read {
                    NextMutation = Clock.Elapsed.TotalSeconds + 1.0
                }
                let response = ApiResponse(result.Output)
                if timer.Elapsed.TotalSeconds >= 60.0 {
                    throw Failure(response.Status, read, response.Delay(response.RateLimited()))
                }
                if response.Status == 304 {
                    ConditionalResponses++
                    if !conditional || (response.ETag != "" && !WeakETagMatch(response.ETag, cached.ETag)) {
                        throw Exception(
                            "GitHub returned HTTP 304 without a matching in-memory body. Read failed closed."
                        )
                    }
                    return cached.Body
                }
                if response.Status == 404 && missing {
                    Cache.Remove(key)
                    return JsonElement{}
                }
                if response.Status >= 200 && response.Status < 300 && result.Code == 0 {
                    var value JsonElement
                    try {
                        value = response.Body.Trim() == "" ? JsonElement{}: J.Parse(response.Body)
                    } catch {
                        throw Failure(0, read, 0.0)
                    }
                    if read {
                        Cache.Remove(key)
                        if ValidETag(response.ETag) && value.ValueKind != JsonValueKind.Undefined {
                            Cache[key] = ApiCache{ETag: response.ETag, Body: value}
                        }
                    }
                    return value
                }
                let limited = response.RateLimited()
                let retryable = response.Status == 0 ||
                    (response.Status >= 200 && response.Status < 300) ||
                    response.Status >= 500 ||
                    limited
                let delay = Math.Max(response.Delay(limited), retryable ? Convert.ToDouble(attempt + 1): 0.0)
                if !read || !retryable || attempt == 2 || delay >= 60.0 - timer.Elapsed.TotalSeconds {
                    throw Failure(response.Status, read, delay)
                }
                Wait(delay)
            }
            throw Failure(0, read, 0.0)
        }
    }
}
