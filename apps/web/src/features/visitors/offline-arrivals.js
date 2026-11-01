const DATABASE = 'societyos-security-gate';
const VERSION = 2;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB || !globalThis.crypto?.subtle) {
      reject(new Error('Secure offline storage is not available in this browser.'));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('keys')) database.createObjectStore('keys');
      if (!database.objectStoreNames.contains('arrivals')) database.createObjectStore('arrivals', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open secure offline storage.'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Offline storage request failed.'));
  });
}

async function encryptionKey(database) {
  const existing = await requestResult(database.transaction('keys', 'readonly').objectStore('keys').get('arrivals'));
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await requestResult(database.transaction('keys', 'readwrite').objectStore('keys').put(key, 'arrivals'));
  return key;
}

async function encrypt(value, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv, ciphertext };
}

async function decrypt(record, key) {
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.ciphertext);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function queueArrival(request) {
  const database = await openDatabase();
  try {
    const key = await encryptionKey(database);
    const id = request.clientRequestId || crypto.randomUUID();
    const encrypted = await encrypt({ ...request, clientRequestId: id, state: 'QUEUED' }, key);
    await requestResult(database.transaction('arrivals', 'readwrite').objectStore('arrivals').put({ id, ...encrypted, createdAt: new Date().toISOString() }));
    return id;
  } finally {
    database.close();
  }
}

export async function listQueuedArrivals() {
  const database = await openDatabase();
  try {
    const key = await encryptionKey(database);
    const records = await requestResult(database.transaction('arrivals', 'readonly').objectStore('arrivals').getAll());
    return Promise.all(records.map(async (record) => ({ id: record.id, createdAt: record.createdAt, ...await decrypt(record, key) })));
  } finally {
    database.close();
  }
}

export async function updateQueuedArrival(id, changes) {
  const arrivals = await listQueuedArrivals();
  const current = arrivals.find((item) => item.id === id);
  if (!current) return;
  const database = await openDatabase();
  try {
    const key = await encryptionKey(database);
    const encrypted = await encrypt({ ...current, ...changes }, key);
    await requestResult(database.transaction('arrivals', 'readwrite').objectStore('arrivals').put({ id, ...encrypted, createdAt: current.createdAt }));
  } finally {
    database.close();
  }
}

export async function removeQueuedArrival(id) {
  const database = await openDatabase();
  try {
    await requestResult(database.transaction('arrivals', 'readwrite').objectStore('arrivals').delete(id));
  } finally {
    database.close();
  }
}

export async function saveOfflineFlats(flats) {
  const database = await openDatabase();
  try {
    const key = await encryptionKey(database);
    const encrypted = await encrypt(flats, key);
    await requestResult(database.transaction('settings', 'readwrite').objectStore('settings').put(encrypted, 'flats'));
  } finally {
    database.close();
  }
}

export async function loadOfflineFlats() {
  const database = await openDatabase();
  try {
    const key = await encryptionKey(database);
    const record = await requestResult(database.transaction('settings', 'readonly').objectStore('settings').get('flats'));
    return record ? await decrypt(record, key) : [];
  } finally {
    database.close();
  }
}
