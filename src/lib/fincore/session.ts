// Device identity for the demo.
//
// There is no real WhatsApp number here — this browser session stands in
// for "your phone". The synthetic number is persisted in localStorage so a
// reload keeps you logged in as the same FinCore account; "Switch Device"
// generates a new number and unlinks it, so the recovery/OTP flow (§3 of the
// architecture plan) has something real to demonstrate.

const DEVICE_PHONE_KEY = "fincore_device_phone_v1";

function randomPhoneNumber(): string {
  const digits = Math.floor(10_000_000 + Math.random() * 89_999_999);
  return `+91-DEMO-${digits}`;
}

export function getDevicePhoneNumber(): string {
  if (typeof localStorage === "undefined") return randomPhoneNumber();
  let phone = localStorage.getItem(DEVICE_PHONE_KEY);
  if (!phone) {
    phone = randomPhoneNumber();
    localStorage.setItem(DEVICE_PHONE_KEY, phone);
  }
  return phone;
}

export function switchDevice(): string {
  const next = randomPhoneNumber();
  if (typeof localStorage !== "undefined") localStorage.setItem(DEVICE_PHONE_KEY, next);
  return next;
}

export function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
