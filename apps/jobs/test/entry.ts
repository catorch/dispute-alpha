// Minimal worker entry for the test runtime (the real entry needs workflow/container bindings).
export default { fetch: () => new Response("ok") };
