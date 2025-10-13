const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

// Store config per role
async function setConfig(guildId, roleId, config) {
  await redis.hset(`config:${guildId}`, roleId, JSON.stringify(config));
}

// Get config for a specific role
async function getConfig(guildId, roleId) {
  const raw = await redis.hget(`config:${guildId}`, roleId);
  return raw ? JSON.parse(raw) : null;
}

// Delete config for a role
async function deleteConfig(guildId, roleId) {
  await redis.hdel(`config:${guildId}`, roleId);
}

// List all configs for a guild
async function listConfigs(guildId) {
  const all = await redis.hgetall(`config:${guildId}`);
  const parsed = {};
  for (const [roleId, raw] of Object.entries(all)) {
    parsed[roleId] = JSON.parse(raw);
  }
  return parsed;
}

// Onboarding state
async function setOnboarding(guildId, set) {
  await redis.set(`onboarding:${guildId}`, JSON.stringify([...set]));
}

async function getOnboarding(guildId) {
  const raw = await redis.get(`onboarding:${guildId}`);
  return raw ? new Set(JSON.parse(raw)) : new Set();
}

module.exports = {
  setConfig,
  getConfig,
  deleteConfig,
  listConfigs,
  setOnboarding,
  getOnboarding
};
