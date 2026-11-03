import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { FlashJob } from './src/flasher';
import appConfig from './app.json';
import { buildHexView } from './src/hexview';
import { Segment, imageSize, parseFirmware } from './src/image';
import { Config, Session } from './src/session';
import { Utf8Stream, b64decode, encodeUtf8, hex32 } from './src/util';

const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_TERM = 200000;
const HEX_ROW_H = 15;
/** STM32F103CBT6 (128 KB medium-density): flash 0x08000000 - 0x0801FFFF. Example/reference default for .bin files. */
const DEFAULT_FW_BASE = '08000000';
type Page = 'rtt' | 'usb';
const EOLS: { label: string; value: string }[] = [
  { label: 'LF', value: '\n' },
  { label: 'CR', value: '\r' },
  { label: 'CRLF', value: '\r\n' },
  { label: 'none', value: '' },
];

function parseHex(s: string): number | null {
  const t = s.trim().replace(/^0x/i, '');
  if (t === '' || !/^[0-9a-fA-F]+$/.test(t)) return null;
  return parseInt(t, 16) >>> 0;
}

export default function App() {
  const [speed, setSpeed] = useState('4000');
  const [start, setStart] = useState('0x20000000');
  const [size, setSize] = useState('0x20000');
  const [addr, setAddr] = useState('');
  const [power, setPower] = useState(false);
  const [eol, setEol] = useState(0);
  const [status, setStatus] = useState('Idle');
  const [term, setTerm] = useState('');
  const [usbTerm, setUsbTerm] = useState('');
  const [page, setPage] = useState<Page>('rtt'); // RTT page is shown first
  const [unseen, setUnseen] = useState({ rtt: false, usb: false });
  const pageRef = useRef<Page>('rtt');
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [showFw, setShowFw] = useState(false);
  const [fwName, setFwName] = useState('');
  const [fwBase, setFwBase] = useState(DEFAULT_FW_BASE);
  const [fwBusy, setFwBusy] = useState(false);
  const [fwPct, setFwPct] = useState(0);
  const [fwLabel, setFwLabel] = useState('');
  const fwBytes = useRef<Uint8Array | null>(null);
  const fwFile = useRef('');
  const fwJob = useRef<FlashJob | null>(null);
  const fwUiTime = useRef(0);
  const [fwVer, setFwVer] = useState(0);
  const [fwRaw, setFwRaw] = useState(false);

  // Parse the chosen file (re-parsed when the .bin base address changes) and build the hex-editor view.
  const preview = useMemo(() => {
    const bytes = fwBytes.current;
    if (!bytes) return null;
    try {
      const isBin = !/\.(hex|ihex)$/i.test(fwFile.current) && bytes[0] !== 0x3a;
      const base = fwBase.trim() === '' ? null : parseHex(fwBase);
      if (fwBase.trim() !== '' && base === null) throw new Error('Bad base address');
      const segs = parseFirmware(fwFile.current, bytes, isBin ? base ?? 0 : null);
      return { segs, error: null as string | null, needsBase: isBin && base === null };
    } catch (e) {
      return { segs: null as Segment[] | null, error: e instanceof Error ? e.message : String(e), needsBase: false };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fwVer, fwBase]);

  const hexView = useMemo(() => {
    const bytes = fwBytes.current;
    if (!bytes || !preview) return null;
    if (fwRaw) return buildHexView([{ addr: 0, data: bytes }]);
    return preview.segs ? buildHexView(preview.segs) : null;
  }, [preview, fwRaw, fwVer]);
  const hexRows = useMemo(
    () => (hexView ? Array.from({ length: hexView.rowCount }, (_, i) => i) : []),
    [hexView],
  );

  const session = useRef<Session | null>(null);
  const utf8 = useRef(new Utf8Stream());
  const pending = useRef('');
  const usbPending = useRef('');
  const ansiTail = useRef('');
  const scroll = useRef<ScrollView>(null);

  // Flush received text to the UI at ~10 Hz instead of per chunk.
  useEffect(() => {
    const cap = (s: string) => (s.length > MAX_TERM ? s.slice(s.length - MAX_TERM / 2) : s);
    const t = setInterval(() => {
      if (pending.current !== '') {
        const add = pending.current;
        pending.current = '';
        setTerm((prev) => cap(prev + add));
        if (pageRef.current !== 'rtt') setUnseen((u) => (u.rtt ? u : { ...u, rtt: true }));
      }
      if (usbPending.current !== '') {
        const add = usbPending.current;
        usbPending.current = '';
        setUsbTerm((prev) => cap(prev + add));
        if (pageRef.current !== 'usb') setUnseen((u) => (u.usb ? u : { ...u, usb: true }));
      }
    }, 100);
    return () => clearInterval(t);
  }, []);

  const onData = useCallback((bytes: Uint8Array) => {
    let s = ansiTail.current + utf8.current.decode(bytes);
    ansiTail.current = '';
    const esc = s.lastIndexOf('\u001B');
    if (esc >= 0 && !/^\u001B\[[0-9;?]*[ -/]*[@-~]/.test(s.slice(esc))) {
      ansiTail.current = s.slice(esc);
      s = s.slice(0, esc);
    }
    pending.current += s.replace(ANSI, '').replace(/\r/g, '');
  }, []);

  const connect = () => {
    if (session.current) {
      session.current.stop();
      setStatus('Disconnecting...');
      return;
    }
    const sp = parseInt(speed, 10);
    const st = parseHex(start);
    const sz = parseHex(size);
    const fixed = addr.trim() === '' ? null : parseHex(addr);
    if (!(sp >= 1 && sp <= 50000) || st === null || sz === null || sz <= 0 || (addr.trim() !== '' && fixed === null)) {
      setStatus('Check speed / RAM start / size / address fields');
      return;
    }
    const cfg: Config = {
      speedKhz: Math.min(sp, 0xfffe),
      searchStart: st,
      searchSize: sz,
      fixedAddr: fixed,
      targetPower: power,
    };
    utf8.current = new Utf8Stream();
    ansiTail.current = '';
    const s = new Session(cfg, {
      status: setStatus,
      data: onData,
      log: (line) => {
        usbPending.current += line + '\n';
      },
      ended: (reason) => {
        session.current = null;
        setConnected(false);
        setStatus(reason);
      },
    });
    session.current = s;
    setConnected(true);
    void s.run();
  };

  const send = () => {
    const s = session.current;
    if (!s) {
      setStatus('Not connected');
      return;
    }
    const text = input + EOLS[eol].value;
    if (text.length > 0) s.send(encodeUtf8(text));
    setInput('');
  };

  useEffect(() => () => {
    session.current?.stop();
    fwJob.current?.cancel();
  }, []);

  const selectPage = (p: Page) => {
    pageRef.current = p;
    setPage(p);
    setUnseen((u) => ({ ...u, [p]: false }));
  };

  const pickFirmware = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (res.canceled || res.assets.length === 0) return;
      const a = res.assets[0];
      const b64 = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.Base64 });
      const bytes = b64decode(b64);
      fwBytes.current = bytes;
      fwFile.current = a.name;
      setFwVer((v) => v + 1);
      setFwName(a.name + ' (' + bytes.length + ' bytes)');
      setFwPct(0);
      setFwLabel('');
    } catch (e) {
      setStatus('Could not read file: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const runFlash = (segs: Segment[], sp: number) => {
    void activateKeepAwakeAsync('flash');
    selectPage('usb'); // flashing progress is logged on the USB page
    const job = new FlashJob(
      { speedKhz: Math.min(sp, 0xfffe), targetPower: power, segments: segs, runAfter: true },
      {
        log: (line) => {
          usbPending.current += '[flash] ' + line + '\n';
          setStatus(line);
        },
        progress: (f, label) => {
          const now = Date.now();
          if (now - fwUiTime.current < 150 && f < 1) return;
          fwUiTime.current = now;
          setFwPct(Math.round(f * 100));
          setFwLabel(label);
        },
        ended: (ok, msg) => {
          fwJob.current = null;
          deactivateKeepAwake('flash');
          setFwBusy(false);
          setStatus(msg);
          usbPending.current += '[flash] ' + msg + '\n';
          if (ok) {
            setFwPct(100);
            setFwLabel('Done');
          }
        },
      },
    );
    fwJob.current = job;
    setFwBusy(true);
    setFwPct(0);
    setFwLabel('Starting');
    void job.run();
  };

  const startFlash = () => {
    if (session.current) {
      setStatus('Disconnect the RTT session first');
      return;
    }
    const bytes = fwBytes.current;
    if (!bytes) {
      setStatus('Choose a firmware file first');
      return;
    }
    const sp = parseInt(speed, 10);
    if (!(sp >= 1 && sp <= 50000)) {
      setStatus('Check the SWD speed field');
      return;
    }
    if (!preview || !preview.segs) {
      Alert.alert('Firmware file', preview?.error ?? 'Choose a firmware file first');
      return;
    }
    const segs = preview.segs;
    const last = segs[segs.length - 1];
    Alert.alert(
      'Update firmware?',
      imageSize(segs) + ' bytes, ' + hex32(segs[0].addr) + ' - ' + hex32(last.addr + last.data.length - 1) +
        '\n\nThe flash sectors covering this range will be ERASED and reprogrammed, then verified. ' +
        'Do not unplug the probe or close the app until it finishes.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Flash', style: 'destructive', onPress: () => runFlash(segs, sp) },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.row}>
          <TextInput style={[styles.field, styles.flex]} value={speed} onChangeText={setSpeed}
            keyboardType="number-pad" placeholder="SWD kHz" />
          <TextInput style={[styles.field, styles.flex2]} value={start} onChangeText={setStart}
            autoCapitalize="none" placeholder="RAM start (hex)" />
          <TextInput style={[styles.field, styles.flex]} value={size} onChangeText={setSize}
            autoCapitalize="none" placeholder="size (hex)" />
        </View>
        <View style={styles.row}>
          <TextInput style={[styles.field, styles.flex2]} value={addr} onChangeText={setAddr}
            autoCapitalize="none" placeholder="RTT CB addr (hex, optional)" />
          <Text style={styles.small}>5V</Text>
          <Switch value={power} onValueChange={setPower} disabled={connected} />
          <Button title={connected ? 'Disconnect' : 'Connect'} onPress={connect} disabled={fwBusy} />
        </View>
        <View style={styles.row}>
          <Button title={showFw ? 'Hide firmware update' : 'Firmware update...'} onPress={() => setShowFw(!showFw)} />
          <View style={styles.flex} />
          <Text style={styles.small}>
            {'v' + appConfig.expo.version + ' (build ' + appConfig.expo.android.versionCode + ')'}
          </Text>
        </View>
        {showFw && (
          <View style={styles.fwBox}>
            <View style={styles.row}>
              <Button title="Choose file" onPress={() => void pickFirmware()} disabled={fwBusy} />
              <Text style={[styles.small, styles.flex]} numberOfLines={2}>{fwName || 'no file (.hex or .bin)'}</Text>
            </View>
            <View style={styles.row}>
              <TextInput style={[styles.field, styles.flex]} value={fwBase} onChangeText={setFwBase}
                autoCapitalize="none" placeholder="base addr for .bin (hex)" editable={!fwBusy} />
              <Button title="Flash" onPress={startFlash} disabled={fwBusy || !fwName} />
              <Button title="Cancel" onPress={() => fwJob.current?.cancel()} disabled={!fwBusy} />
            </View>
            <Text style={styles.small}>
              Example: STM32F103CBT6 flash starts at 08000000 (128 KB, up to 0801FFFF). Used for .bin files only - a .hex file carries its own addresses.
            </Text>
            {preview && (
              <Text style={[styles.small, preview.error ? styles.err : null]}>
                {preview.error
                  ? preview.error
                  : preview.segs
                    ? preview.segs.length + ' segment(s), ' + imageSize(preview.segs) + ' bytes, ' +
                      hex32(preview.segs[0].addr) + ' - ' +
                      hex32(preview.segs[preview.segs.length - 1].addr + preview.segs[preview.segs.length - 1].data.length - 1)
                    : ''}
              </Text>
            )}
            {hexView && (
              <>
                <View style={styles.row}>
                  <Button title={fwRaw ? 'Show: file bytes' : 'Show: flash image'} onPress={() => setFwRaw(!fwRaw)} />
                  <Text style={[styles.small, styles.flex]}>
                    {fwRaw ? 'raw file bytes (offsets from 0)' : 'what will be written, by flash address'}
                  </Text>
                </View>
                <FlatList
                  style={styles.hexList}
                  data={hexRows}
                  keyExtractor={(i: number) => String(i)}
                  getItemLayout={(_: unknown, index: number) => ({ length: HEX_ROW_H, offset: HEX_ROW_H * index, index })}
                  initialNumToRender={30}
                  maxToRenderPerBatch={40}
                  windowSize={9}
                  renderItem={({ item }: { item: number }) => <Text style={styles.hexRow} numberOfLines={1}>{hexView.row(item)}</Text>}
                />
              </>
            )}
            <View style={styles.bar}><View style={[styles.barFill, { width: `${fwPct}%` }]} /></View>
            <Text style={styles.small}>{fwLabel ? fwPct + '%  ' + fwLabel : ''}</Text>
          </View>
        )}
        <Text style={styles.status}>{status}</Text>
        <ScrollView
          ref={scroll}
          style={styles.term}
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        >
          <Text selectable style={styles.termText}>{page === 'rtt' ? term : usbTerm}</Text>
        </ScrollView>
        <View style={styles.tabs}>
          {(['rtt', 'usb'] as const).map((p) => (
            <Pressable key={p} style={[styles.tab, page === p && styles.tabOn]} onPress={() => selectPage(p)}>
              <Text style={[styles.tabText, page === p && styles.tabTextOn]}>
                {(p === 'rtt' ? 'RTT messages' : 'USB messages') + (unseen[p] && page !== p ? '  \u25CF' : '')}
              </Text>
            </Pressable>
          ))}
          <Button title="Clr" onPress={() => (page === 'rtt' ? setTerm('') : setUsbTerm(''))} />
        </View>
        {page === 'rtt' && (
          <View style={styles.row}>
            <TextInput
              style={[styles.field, styles.flex2, styles.mono]}
              value={input}
              onChangeText={setInput}
              onSubmitEditing={send}
              blurOnSubmit={false}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="command"
              returnKeyType="send"
            />
            <Button title={EOLS[eol].label} onPress={() => setEol((eol + 1) % EOLS.length)} />
            <Button title="Send" onPress={send} />
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff', paddingTop: Platform.OS === 'android' ? 28 : 0 },
  flex: { flex: 1 },
  flex2: { flex: 1.5 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, gap: 6 },
  field: { borderBottomWidth: 1, borderColor: '#999', paddingVertical: 4, fontSize: 13 },
  small: { fontSize: 12 },
  status: { fontSize: 12, padding: 4, color: '#333' },
  term: { flex: 1, backgroundColor: '#101010', margin: 4 },
  termText: { color: '#e0e0e0', fontFamily: 'monospace', fontSize: 12, padding: 6 },
  mono: { fontFamily: 'monospace' },
  hexList: { height: 210, backgroundColor: '#101010', borderRadius: 4 },
  hexRow: { height: HEX_ROW_H, color: '#d0e8d0', fontFamily: 'monospace', fontSize: 11, paddingHorizontal: 4 },
  err: { color: '#c62828' },
  tabs: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, gap: 6, marginBottom: 2 },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 6, backgroundColor: '#e3e3e3', alignItems: 'center' },
  tabOn: { backgroundColor: '#1e5bff' },
  tabText: { fontSize: 13, color: '#333' },
  tabTextOn: { color: '#fff', fontWeight: '600' },
  fwBox: { borderWidth: 1, borderColor: '#bbb', borderRadius: 6, margin: 6, padding: 6, gap: 4 },
  bar: { height: 8, backgroundColor: '#ddd', borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, backgroundColor: '#2e7d32' },
});
