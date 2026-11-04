#include <metal_stdlib>
using namespace metal;

struct FlameWeight {
    float value;
    float2 gradient;
};

// Forward mapping matches FlameTouchPhysics.displacement. Its analytic
// gradient keeps the inverse inexpensive: one exponential per iteration.
FlameWeight flameWeight(float2 p, float2 grab, float carry) {
    float2 d = p - float2(106.75, 134.1666667) - grab;
    float rawLower = ((p.y / 262.5 - .2) / (560.0 / 900) - .48) / .42;
    float lower = clamp(rawLower, 0.0, 1.0);
    float rooted = 1 - lower * lower * (3 - 2 * lower);
    float rootDerivative = rawLower > 0 && rawLower < 1
        ? -6 * lower * (1 - lower) / (262.5 * (560.0 / 900) * .42) : 0;
    float gaussian = exp(-dot(d, d) / (2 * 65 * 65)) * (1 - .84 * carry);
    float value = gaussian * (rooted + (1 - rooted) * carry);
    float2 gradient = -d * value / (65 * 65)
        + float2(0, gaussian * (1 - carry) * rootDerivative);
    return {value, gradient};
}

// SwiftUI samples destination-to-source. The padded layer lets the tip
// stretch outside the avatar's layout bounds without clipping.
[[ stitchable ]] float2 flameStretch(float2 position, float size, float padding,
                                     float2 grab, float2 stretch, float carry) {
    float scale = size / 210.0;
    float2 destination = (position - padding) / scale;
    float2 source = destination;
    for (int i = 0; i < 8; ++i) {
        FlameWeight w = flameWeight(source, grab, carry);
        float2 error = source + stretch * w.value - destination;
        float denominator = max(.08, 1 + dot(w.gradient, stretch));
        float2 correction = error - stretch * (dot(w.gradient, error) / denominator);
        source -= clamp(correction, float2(-30), float2(30));
    }
    return source * scale + padding;
}
