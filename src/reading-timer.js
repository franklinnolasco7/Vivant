import * as api from "./api.js";

const READING_TIME_TICK_MS = 15000;
// Cap single delta to prevent burst accumulation if tab stayed hidden for hours
const MAX_READING_TIME_STEP_SEC = 120;

let _readingTimeTimer = null;
let _lastReadingTickAt = 0;
let _pendingReadingSeconds = 0;
let _readingTimeQueue = Promise.resolve();
let _book = null;
let _readerActive = false;

export function init() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flush();
      stop();
      return;
    }
    if (_readerActive && _book) start();
  });
}

export function setActive(isActive) {
  _readerActive = Boolean(isActive);
  if (_readerActive && _book && document.visibilityState === "visible") {
    start();
  } else {
    void flush().finally(() => stop());
  }
}

export function setBook(book) {
  _book = book;
  if (!book) {
    void flush().finally(() => stop());
  }
}

export function start() {
  stop();
  _lastReadingTickAt = Date.now();
  _readingTimeTimer = setInterval(() => {
    void captureTick(false);
  }, READING_TIME_TICK_MS);
}

export function stop() {
  if (_readingTimeTimer) {
    clearInterval(_readingTimeTimer);
    _readingTimeTimer = null;
  }
  _lastReadingTickAt = 0;
}

export async function flush() {
  await captureTick(true);
  await _readingTimeQueue;
}

async function captureTick(force) {
  if (!_book) return;

  const now = Date.now();
  if (!_lastReadingTickAt) {
    _lastReadingTickAt = now;
    return;
  }

  let deltaSec = Math.floor((now - _lastReadingTickAt) / 1000);
  _lastReadingTickAt = now;
  if (deltaSec <= 0) return;

  deltaSec = Math.min(deltaSec, MAX_READING_TIME_STEP_SEC);

  if (!force) {
    if (!_readerActive || document.visibilityState !== "visible") return;
  }

  _pendingReadingSeconds += deltaSec;
  const shouldFlush = force || _pendingReadingSeconds >= 15;
  if (!shouldFlush) return;
  // Bundle seconds and send atomically so partial reads don't get lost on retry

  const secondsToSave = _pendingReadingSeconds;
  _pendingReadingSeconds = 0;

  const bookId = _book.id;

  _readingTimeQueue = _readingTimeQueue
    .catch(() => {})
    .then(async () => {
      try {
        await api.addReadingTime(bookId, secondsToSave);
        if (_book && _book.id === bookId) {
          _book.reading_seconds = (Number(_book.reading_seconds) || 0) + secondsToSave;
        }
      } catch {
        if (_book && _book.id === bookId) {
          _pendingReadingSeconds += secondsToSave;
        }
      }
    });
}
