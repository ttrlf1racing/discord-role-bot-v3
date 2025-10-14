// kvRedis.js — Redis helper for Railway internal/external URLs
const { createClient } = require('redis');

let redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error('❌ Missing REDIS_URL!');
  process.exit(1);
}

// detect if proxy host (external) or internal
const useTLS = redisUrl.startsWith('rediss://') || redisUrl.includes('.proxy.rlwy.net');
console.log(`🔗 Connecting to Redis: ${redisUrl} (TLS: ${useTLS ? 'on' : 'off'})`);

const redis = createClient({
  url: redisUrl,
  socket: {
    tls: useTLS,
    reconnectStrategy: retries => Math.min(retries * 500, 5000)
  }
});

redis.on('error', err => console.error('❌ Redis Client Error:', err.message));
redis.on('connect', () => console.log('✅ Redis client connected'));
redis.on('reconnecting', () => console.log('♻️ Reconnecting to Redis...'));

(async () => {
  try {
    await redis.connect();
  } catch (err) {
    console.error('❌ Redis connect error:', err);
  }
})();

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

  async deleteConfig(guildId) {
    try {
      await redis.del(`config:${guildId}`);
    } catch (err) {
      console.error('❌ Redis deleteConfig error:', err);
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
