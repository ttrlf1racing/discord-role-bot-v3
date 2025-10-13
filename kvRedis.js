const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

module.exports = {
  async getConfig(guildId) {
    const raw = await redis.get(`config:${guildId}`);
    return raw ? JSON.parse(raw) : null;
  },
  async setConfig(guildId, config) {
    await redis.set(`config:${guildId}`, JSON.stringify(config));
  },
  async deleteConfig(guildId) {
    await redis.del(`config:${guildId}`);
  },
  async getOnboarding(guildId) {
    const raw = await redis.get(`onboarding:${guildId}`);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  },
  async setOnboarding(guildId, userSet) {
    await redis.set(`onboarding:${guildId}`, JSON.stringify(Array.from(userSet)));
  }
};
