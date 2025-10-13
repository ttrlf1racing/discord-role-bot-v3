// kvRedis.js — persistent Redis key-value store

const { createClient } = require('redis');

const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redis.on('error', err => console.error('❌ Redis Client Error', err));
redis.connect();

module.exports = {
  async getConfig(guildId) {
    try {
      const raw = await redis.get(`config:${guildId}`);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error('❌ Redis getConfig error:', err);
      return null;
    }
  },

  async setConfig(guildId, config) {
    try {
      await redis.set(`config:${guildId}`, JSON.stringify(config));
    } catch (err) {
      console.error('❌ Redis setConfig error:', err);
    }
  },

  async getOnboarding(guildId) {
    try {
      const data = await redis.sMembers(`onboarding:${guildId}`);
      return new Set(data || []);
    } catch (err) {
      console.error('❌ Redis getOnboarding error:', err);
      return new Set();
    }
  },

  async setOnboarding(guildId, set) {
    try {
      const key = `onboarding:${guildId}`;
      await redis.del(key);
      if (set.size > 0) await redis.sAdd(key, [...set]);
    } catch (err) {
      console.error('❌ Redis setOnboarding error:', err);
    }
  }
};
