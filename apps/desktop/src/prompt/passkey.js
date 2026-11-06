// The passkey box (main.mjs, Bluetooth pairing on Windows and Linux): six digits, or Cancel.
const form = document.getElementById('form');
const pin = document.getElementById('pin');
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (/^[0-9]{6}$/.test(pin.value)) window.passkey.answer(pin.value);
});
document.getElementById('cancel').addEventListener('click', () => window.passkey.answer(null));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.passkey.answer(null);
});
