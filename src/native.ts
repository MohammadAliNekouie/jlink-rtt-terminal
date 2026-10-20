import { requireNativeModule } from 'expo';

export interface JLinkDeviceInfo {
  name: string;
  vid: number;
  pid: number;
}

interface JLinkUsbNative {
  listDevices(): JLinkDeviceInfo[];
  requestPermission(name: string): Promise<boolean>;
  open(name: string): Promise<boolean>;
  /** Write base64 data (may be ""), then read exactly `expect` bytes; returns base64. */
  transact(b64: string, expect: number): Promise<string>;
  close(): void;
}

export default requireNativeModule<JLinkUsbNative>('JLinkUsb');
