package TokateTests

import Gsharp.Concurrency
import System
import System.IO
import System.Net
import System.Net.Sockets
import System.Text

internal class PiCatalog : IDisposable {
    shared {
        internal func Configure(flow NativeFixture, endpoint string) {
            let root = Path.Combine(flow.Temp.Root, "runtime/node_modules")
            let installed = Path.Combine(root, "@earendil-works/pi-coding-agent")
            Directory.CreateDirectory(Path.Combine(installed, "dist"))
            File.WriteAllText(
                Path.Combine(installed, "package.json"),
                "{\"name\":\"@earendil-works/pi-coding-agent\",\"version\":\"fixture-continuation\",\"type\":\"module\"}"
            )
            File.WriteAllText(Path.Combine(installed, "dist/index.js"), TestResources.Template("PiContinuation.mjs"))
            let config = Path.Combine(flow.Temp.Root, "pi-models")
            Directory.CreateDirectory(config)
            flow.Temp.Env["PI_CODING_AGENT_DIR"] = config
            File.WriteAllText(
                Path.Combine(config, "models.json"),
                "{\"providers\":{\"local\":{\"baseUrl\":\"" +
                    endpoint +
                    "\",\"api\":\"openai-completions\",\"models\":[{\"id\":\"fixture-model\",\"reasoning\":false,\"contextWindow\":32768,\"maxTokens\":4096}]}}}"
            )
        }
    }

    private let Listener TcpListener = TcpListener(IPAddress.Loopback, 0)
    private let Stopped Chan[bool] = Chan[bool](1)
    internal let Endpoint string

    internal init() {
        Listener.Start()
        let port = (Listener.LocalEndpoint as IPEndPoint)?.Port ?? throw Exception("Missing Pi catalog port")
        Endpoint = "http://127.0.0.1:" + port.ToString() + "/v1"
        go Serve()
    }

    private func Serve() {
        try {
            while true {
                using let client = Listener.AcceptTcpClient()
                client.ReceiveTimeout = 2000
                client.SendTimeout = 2000
                using let stream = client.GetStream()
                using let reader = StreamReader(stream)
                let request = reader.ReadLine() ?? ""
                for header in 0 ... 64 {
                    if String.IsNullOrEmpty(reader.ReadLine()) {
                        break
                    }
                    Check.That(header < 63, "Pi catalog request headers exceeded the fixture limit")
                }
                let found = request.StartsWith("GET /v1/models HTTP/", StringComparison.Ordinal)
                let body = found ? "{\"object\":\"list\",\"data\":[{\"id\":\"fixture-model\"}]}": "{}"
                let response = Encoding.UTF8.GetBytes(
                    "HTTP/1.1 " +
                        (found ? "200 OK": "404 Not Found") +
                        "\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " +
                        Encoding
                        .UTF8
                        .GetByteCount(body)
                        .ToString() +
                        "\r\n\r\n" +
                        body
                )
                stream.Write(response)
            }
        } catch (error SocketException) { } catch (error IOException) { } catch (
            error ObjectDisposedException
        ) { } finally {
            Stopped <- true
        }
    }

    public func Dispose() {
        Listener.Stop()
        select {
            case <- Stopped { }
            case <- after(TimeSpan.FromSeconds(3)) {
                throw Exception("Pi catalog did not stop")
            }
        }
    }
}
