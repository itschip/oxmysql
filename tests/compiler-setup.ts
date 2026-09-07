for (const name of ['GetConvar', 'GetCurrentResourceName', 'GetResourceState']) {
  if (name in globalThis) throw new Error('Standalone compiler tests must run without FiveM globals.');
}