const GoogleCalendarProvider = require('./GoogleCalendarProvider');
const AppleCalendarProvider = require('./AppleCalendarProvider');

const providers = [
  new GoogleCalendarProvider(),
  new AppleCalendarProvider(),
];

const providerMap = Object.fromEntries(providers.map((p) => [p.id, p]));

function getAllProviders() {
  return providers;
}

function getProvider(id) {
  const provider = providerMap[id];
  if (!provider) throw new Error(`Unknown calendar provider: ${id}`);
  return provider;
}

module.exports = {
  getAllProviders,
  getProvider,
  GoogleCalendarProvider,
  AppleCalendarProvider,
};
