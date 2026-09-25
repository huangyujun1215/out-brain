export function safeErrorMeta(error: unknown) {
  if (!(error instanceof Error)) return { name: "UnknownError", errorCode: "UNKNOWN_ERROR" };
  const message = error.message.toLowerCase();
  const errorCode = error.name === "ZodError" ? "INVALID_RESPONSE"
    : message.includes("abort") ? "ABORTED"
    : message.includes("timeout") || message.includes("timed out") ? "TIMEOUT"
      : /\b429\b|rate.?limit/.test(message) ? "RATE_LIMITED"
        : /\b401\b|\b403\b|unauthorized|forbidden/.test(message) ? "PROVIDER_AUTH"
          : /schema|validation|parse|invalid json|未调用|tool.?call/.test(message) ? "INVALID_RESPONSE"
            : "INTERNAL_ERROR";
  return { name: error.name.slice(0, 100), errorCode };
}
