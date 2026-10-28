importScripts('shared.js');

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...SV_DEFAULTS, ...(settings || {}) } });
});

// Toolbar badge text sent by the content script (tab-specific).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'sv:badge' && sender.tab) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.text || '' });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#0891b2' });
  }
});
