import type {
  AuthorizedDevice,
  ConnectedDevice,
  WebVIADevice,
} from '../types/types';

var lastWriteTimestamp = Date.now();
// This is a bit cray
const globalBuffer: {
  [path: string]: {currTime: number; message: Uint8Array}[];
} = {};
const eventWaitBuffer: {
  [path: string]: ((a: Uint8Array) => void)[];
} = {};
type InputReportHandler = (message: Uint8Array) => boolean;
const inputReportHandlers: {
  [path: string]: InputReportHandler[];
} = {};
// ---- Converter feature-report transport --------------------------------------
// The Tartarus converter's PowerMic builds cannot expose VIA's raw HID interface:
// PowerScribe binds the first HID collection under 0554:1001, so a second one
// steals dictation. Instead the firmware carries VIA's 32-byte packets inside
// the PowerMic's own 39-byte Feature report:
//   host -> device  [0x56 'V', seq, packet(32)]
//   device -> host  [0x56, seq, status, packet(32)]   status 1 = answer ready
// The firmware answers from its main loop, not the USB interrupt, so the first
// read can come back not-ready; poll until it is.
const TUNNEL_FILTER = {vendorId: 0x0554, productId: 0x1001, usagePage: 0x01, usage: 0x00};
const TUNNEL_MAGIC = 0x56;
const TUNNEL_REPORT_LEN = 39;
const TUNNEL_TIMEOUT_MS = 5000;

const isTunnelDevice = (device: HIDDevice) =>
  device.vendorId === TUNNEL_FILTER.vendorId &&
  device.productId === TUNNEL_FILTER.productId &&
  (device.collections?.some(
    (collection) =>
      collection.usagePage === TUNNEL_FILTER.usagePage &&
      collection.usage === TUNNEL_FILTER.usage,
  ) ?? false);

const filterHIDDevices = (devices: HIDDevice[]) =>
  devices.filter(
    (device) =>
      device.collections?.some(
        (collection) =>
          collection.usage === 0x61 && collection.usagePage === 0xff60,
      ) || isTunnelDevice(device),
  );

let tunnelSeq = 0;
let tunnelChain: Promise<unknown> = Promise.resolve();

// One request/answer exchange over the Feature report. Chained, so two callers can
// never interleave a SET with someone else's GET.
const tunnelExchange = (device: HIDDevice, packet: Uint8Array) => {
  const run = async () => {
    const seq = (tunnelSeq = (tunnelSeq + 1) & 0xff);
    const out = new Uint8Array(TUNNEL_REPORT_LEN);
    out[0] = TUNNEL_MAGIC;
    out[1] = seq;
    out.set(packet.subarray(0, 32), 2);
    await device.sendFeatureReport(0, out);
    const started = Date.now();
    for (;;) {
      const dv = await device.receiveFeatureReport(0);
      const a = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      // Chrome has returned the report both with and without the report-id byte.
      const o = a[0] === TUNNEL_MAGIC ? 0 : a[1] === TUNNEL_MAGIC ? 1 : -1;
      if (o >= 0 && a[o + 1] === seq && a[o + 2] === 1) {
        return a.slice(o + 3, o + 3 + 32);
      }
      if (Date.now() - started > TUNNEL_TIMEOUT_MS) {
        throw new Error('converter did not answer the VIA request');
      }
      await new Promise((r) => setTimeout(r, 4));
    }
  };
  const result = tunnelChain.then(run, run);
  tunnelChain = result.catch(() => undefined);
  return result;
};

export const QMK_CONSOLE_FILTER = {
  usagePage: 0xff31,
  usage: 0x74,
};

export const isQMKConsoleDevice = (device: HIDDevice) =>
  device.collections?.some(
    (collection) =>
      collection.usage === QMK_CONSOLE_FILTER.usage &&
      collection.usagePage === QMK_CONSOLE_FILTER.usagePage,
  ) ?? false;

const getVIAPathIdentifier = () =>
  (self.crypto && self.crypto.randomUUID && self.crypto.randomUUID()) ||
  `via-path:${Math.random()}`;

const tagDevice = (device: HIDDevice): WebVIADevice => {
  // This is super important in order to have a stable way to identify the same device
  // that was already scanned. It's a bit hacky but https://github.com/WICG/webhid/issues/7
  // ¯\_(ツ)_/¯
  const path = (device as any).__path || getVIAPathIdentifier();
  (device as any).__path = path;
  const HIDDevice = {
    _device: device,
    usage: 0x61,
    usagePage: 0xff60,
    interface: 0x0001,
    vendorId: device.vendorId ?? -1,
    productId: device.productId ?? -1,
    path,
    productName: device.productName,
  };
  return (ExtendedHID._cache[path] = HIDDevice);
};

// Attempt to forget device
export const tryForgetDevice = (device: ConnectedDevice | AuthorizedDevice) => {
  const cachedDevice = ExtendedHID._cache[device.path];
  if (cachedDevice) {
    return cachedDevice._device.forget();
  }
};

const ExtendedHID = {
  _cache: {} as {[key: string]: WebVIADevice},
  requestDevice: async () => {
    const requestedDevice = await navigator.hid.requestDevice({
      filters: [
        {
          usagePage: 0xff60,
          usage: 0x61,
        },
        TUNNEL_FILTER,
        QMK_CONSOLE_FILTER,
      ],
    });
    const viaDevices = filterHIDDevices(requestedDevice);
    viaDevices.forEach(tagDevice);
    return viaDevices[0];
  },
  getFilteredDevices: async () => {
    try {
      const hidDevices = filterHIDDevices(await navigator.hid.getDevices());
      return hidDevices;
    } catch (e) {
      return [];
    }
  },
  devices: async (requestAuthorize = false) => {
    let devices = await ExtendedHID.getFilteredDevices();
    // TODO: This is a hack to avoid spamming the requestDevices popup
    if (devices.length === 0 || requestAuthorize) {
      try {
        await ExtendedHID.requestDevice();
      } catch (e) {
        // The request seems to fail when the last authorized device is disconnected.
        return [];
      }
      devices = await ExtendedHID.getFilteredDevices();
    }
    return devices.map(tagDevice);
  },
  HID: class HID {
    _hidDevice?: WebVIADevice;
    interface: number = -1;
    vendorId: number = -1;
    productId: number = -1;
    productName: string = '';
    path: string = '';
    openPromise: Promise<void> = Promise.resolve();
    constructor(path: string) {
      this._hidDevice = ExtendedHID._cache[path];
      // TODO: seperate open attempt from constructor as it's async
      // Attempt to connect to the device

      if (this._hidDevice) {
        this.vendorId = this._hidDevice.vendorId;
        this.productId = this._hidDevice.productId;
        this.path = this._hidDevice.path;
        this.interface = this._hidDevice.interface;
        this.productName = this._hidDevice.productName;
        globalBuffer[this.path] = globalBuffer[this.path] || [];
        eventWaitBuffer[this.path] = eventWaitBuffer[this.path] || [];
        inputReportHandlers[this.path] = inputReportHandlers[this.path] || [];
        if (!this._hidDevice._device.opened) {
          this.open();
        }
      } else {
        throw new Error('Missing hid device in cache');
      }
    }
    async open() {
      if (this._hidDevice && !this._hidDevice._device.opened) {
        this.openPromise = this._hidDevice._device.open();
        if (!isTunnelDevice(this._hidDevice._device)) {
          this.setupListeners();
        }
        await this.openPromise;
      }
      return Promise.resolve();
    }
    // Should we unsubscribe at some point of time
    setupListeners() {
      if (this._hidDevice) {
        this._hidDevice._device.addEventListener('inputreport', (e) => {
          const message = new Uint8Array(e.data.buffer);
          const wasHandled = inputReportHandlers[this.path].some((handler) =>
            handler(message),
          );
          if (wasHandled) {
            return;
          }
          if (eventWaitBuffer[this.path].length !== 0) {
            // It should be impossible to have a handler in the buffer
            // that has a ts that happened after the current message
            // came in
            (eventWaitBuffer[this.path].shift() as any)(
              message,
            );
          } else {
            globalBuffer[this.path].push({
              currTime: Date.now(),
              message,
            });
          }
        });
      }
    }

    addInputReportHandler(handler: InputReportHandler) {
      inputReportHandlers[this.path] = inputReportHandlers[this.path] || [];
      inputReportHandlers[this.path].push(handler);
      return () => {
        inputReportHandlers[this.path] = inputReportHandlers[this.path].filter(
          (registeredHandler) => registeredHandler !== handler,
        );
      };
    }

    read(fn: (err?: Error, data?: ArrayBuffer) => void) {
      this.fastForwardGlobalBuffer(lastWriteTimestamp);
      if (globalBuffer[this.path].length > 0) {
        // this should be a noop normally
        fn(undefined, globalBuffer[this.path].shift()?.message as any);
      } else {
        eventWaitBuffer[this.path].push((data) => fn(undefined, data));
      }
    }

    readP = promisify((arg: any) => this.read(arg));

    // The idea is discard any messages that have happened before the time a command was issued
    // since time-travel is not possible yet...
    fastForwardGlobalBuffer(time: number) {
      let messagesLeft = globalBuffer[this.path].length;
      while (messagesLeft) {
        messagesLeft--;
        // message in buffer happened before requested time
        if (globalBuffer[this.path][0].currTime < time) {
          globalBuffer[this.path].shift();
        } else {
          break;
        }
      }
    }

    async write(arr: number[]) {
      await this.openPromise;
      if (this._hidDevice && !this._hidDevice._device.opened) {
        await this.open();
      }
      const data = new Uint8Array(arr.slice(1));
      lastWriteTimestamp = Date.now();
      const device = this._hidDevice?._device;
      if (device && isTunnelDevice(device)) {
        // Hand the answer to read() exactly as an input report would arrive.
        const message = await tunnelExchange(device, data);
        if (eventWaitBuffer[this.path].length !== 0) {
          (eventWaitBuffer[this.path].shift() as any)(message);
        } else {
          globalBuffer[this.path].push({currTime: Date.now(), message});
        }
        return;
      }
      await device?.sendReport(0, data);
    }
  },
};

const promisify = (cb: Function) => () => {
  return new Promise((res, rej) => {
    cb((e: any, d: any) => {
      if (e) rej(e);
      else res(d);
    });
  });
};
export const HID = ExtendedHID;
