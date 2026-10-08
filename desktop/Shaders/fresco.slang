#include "goo_effect.slang"

float grain(float2 p)
{
    return frac(sin(dot(p, float2(127.1, 311.7))) * 43758.5453);
}

float pigment(float2 p)
{
    float2 cell = floor(p);
    float2 f = frac(p);
    f = f * f * (3.0 - 2.0 * f);
    return lerp(lerp(grain(cell), grain(cell + float2(1.0, 0.0)), f.x),
        lerp(grain(cell + float2(0.0, 1.0)), grain(cell + 1.0), f.x), f.y);
}

float4 gooEffect(float2 uv, float4 source, float4 backdrop)
{
    float4 settings = gooParameter(0);
    GooPrimitiveRecord primitive = gooPrimitive();
    float2 size = max(primitive.rect.zw, float2(1.0));
    float3 paint = lerp(source.rgb, backdrop.rgb, settings.w);
    if (settings.y > 0.0)
    {
        float3 mixed = source.rgb;
        float leastVariance = 1e10;
        for (int quadrant = 0; quadrant < 4; quadrant++)
        {
            float2 direction = float2((quadrant & 1) == 0 ? -1.0 : 1.0, quadrant < 2 ? -1.0 : 1.0);
            float3 mean = float3(0.0);
            float3 square = float3(0.0);
            for (int y = 0; y <= 2; y++)
            {
                for (int x = 0; x <= 2; x++)
                {
                    float2 sampleUv = saturate(uv + direction * float2(x, y) * 2.6 / size);
                    float3 sample = gooSourceTexture.Sample(primitive.params.xy + sampleUv * primitive.params.zw).rgb;
                    mean += sample / 9.0;
                    square += sample * sample / 9.0;
                }
            }
            float variance = dot(abs(square - mean * mean), float3(1.0));
            if (variance < leastVariance)
            {
                mixed = mean;
                leastVariance = variance;
            }
        }
        float2 p = uv * size;
        float2 stroke = float2(p.x + p.y * 0.3, p.y - p.x * 0.18);
        float bristle = pigment(stroke / float2(16.0, 1.8)) - 0.5;
        float tooth = pigment(p / 1.2) - 0.5;
        paint = lerp(paint, mixed, 0.65 * settings.y);
        paint *= 1.0 + (bristle * 0.055 + tooth * 0.015) * settings.y;
    }
    paint *= lerp(float3(1.0), float3(0.105, 0.19, 0.34), settings.x);
    return float4(clamp(paint, 0.0, source.a), source.a);
}
