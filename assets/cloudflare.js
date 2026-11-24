// The static catalogue can use the community model without a backend.
const cloudflareAccess = (() => {
  let settings;

  function config() {
    if (!settings) settings = accountRequest('cloudflare-config').catch(error => {
      settings = null;
      if (error.code === 'STATIC_SITE') return {llama:false};
      throw error;
    });
    return settings;
  }

  return {config};
})();
