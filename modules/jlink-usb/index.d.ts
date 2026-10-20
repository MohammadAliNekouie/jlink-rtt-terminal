import type { NativeModule } from 'expo';

export interface JLinkDeviceInfo {
  name: string;
  vid: number;
  pid: number;
}

declare class JLinkUsbModule extends NativeModule {
  listDevices(): JLinkDeviceInfo[];
  requestPermission(name: string): Promise<boolean>;
  open(name: string): Promise<boolean>;
  transact(b64: string, expect: number): Promise<string>;
  close(): void;
}

declare const JLinkUsb: JLinkUsbModule;
export default JLinkUsb;
