import "@testing-library/jest-dom";

// jsdom lacks ResizeObserver — stub it for Radix primitives (Slider, etc.).
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
