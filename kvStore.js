const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'serverConfig.json');
const onboardingPath = path.join(__dirname, 'activeOnboarding.json');

function loadMap(filePath) {
  if (!fs.existsSync(filePath)) return new Map();
  const raw = fs.readFileSync(filePath);
  const obj = JSON.parse(raw);
  return new Map(Object.entries(obj));
}

function saveMap(map, filePath) {
  const obj = Object.fromEntries(map);
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

module.exports = {
  loadServerConfig: () => loadMap(configPath),
  saveServerConfig: (map) => saveMap(map, configPath),
  loadActiveOnboarding: () => {
    const rawMap = loadMap(onboardingPath);
    for (const [guildId, userArray] of rawMap.entries()) {
      rawMap.set(guildId, new Set(userArray));
    }
    return rawMap;
  },
  saveActiveOnboarding: (map) => {
    const obj = {};
    for (const [guildId, userSet] of map.entries()) {
      obj[guildId] = Array.from(userSet);
    }
    fs.writeFileSync(onboardingPath, JSON.stringify(obj, null, 2));
  }
};
