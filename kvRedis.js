// kvRedis.js — in-memory fallback mock
const memory = {
  config: {},
  onboarding: {}
};

module.exports = {
  async getConfig(guildId) {
    return memory.config[guildId] || null;
  },
  async setConfig(guildId, config) {
    memory.config[guildId] = config;
  },
  async getOnboarding(guildId) {
    if (!memory.onboarding[guildId]) memory.onboarding[guildId] = new Set();
    return memory.onboarding[guildId];
  },
  async setOnboarding(guildId, set) {
    memory.onboarding[guildId] = set;
  }
};
