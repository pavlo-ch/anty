async function waitForRuntime() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch('http://127.0.0.1:3032/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Linux runtime did not become ready');
}
module.exports = { waitForRuntime };
