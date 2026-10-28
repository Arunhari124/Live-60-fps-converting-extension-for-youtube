const $ = id => document.getElementById(id);
let settings = { ...SV_DEFAULTS };
const save = () => chrome.storage.local.set({ settings });
chrome.storage.local.get('settings').then(r => {
  settings = { ...SV_DEFAULTS, ...(r.settings || {}) };
  $('autoDegrade').checked = settings.autoDegrade; $('badge').checked = settings.badge;
});
$('autoDegrade').onchange = e => { settings.autoDegrade = e.target.checked; save(); };
$('badge').onchange = e => { settings.badge = e.target.checked; save(); };
$('reset').onclick = () => { settings = { ...SV_DEFAULTS }; save(); $('autoDegrade').checked = settings.autoDegrade; $('badge').checked = settings.badge; };
