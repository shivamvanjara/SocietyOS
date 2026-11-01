import { useEffect, useRef, useState } from 'react';

function invitationCodeFromQr(value) {
  const text = value.trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(text)) return text;
  try {
    const url = new URL(text);
    const code = new URLSearchParams(url.hash.slice(1)).get('invite');
    return code && /^[A-Za-z0-9_-]{43}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

export default function QRScanner({ onCode, onError, label = 'QR code' }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const readerRef = useRef(null);
  const [active, setActive] = useState(false);

  const stop = () => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    readerRef.current?.reset();
    readerRef.current = null;
    setActive(false);
  };

  useEffect(
    () => () => {
      controlsRef.current?.stop();
      readerRef.current?.reset();
    },
    [],
  );

  const start = async () => {
    onError('');
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      const reader = new BrowserQRCodeReader();
      readerRef.current = reader;
      setActive(true);
      controlsRef.current = await reader.decodeFromVideoDevice(
        undefined,
        videoRef.current,
        (result) => {
          if (!result) return;
          const code = invitationCodeFromQr(result.getText());
          if (!code) {
            stop();
            onError(`That QR code is not a valid ${label.toLowerCase()}.`);
            return;
          }
          stop();
          onCode(code);
        },
      );
    } catch {
      stop();
      onError('Camera access is unavailable. Allow camera access or enter the code manually.');
    }
  };

  return (
    <div className="visitor-scanner">
      <video
        ref={videoRef}
        muted
        playsInline
        aria-label={`${label} camera`}
        style={{ display: active ? 'block' : 'none' }}
      />
      {active ? (
        <button type="button" className="button secondary compact" onClick={stop}>
          Stop camera
        </button>
      ) : (
        <button type="button" className="button secondary compact" onClick={start}>
          Scan QR code
        </button>
      )}
    </div>
  );
}
