import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Config, Session } from './src/session';
import { Utf8Stream, encodeUtf8 } from './src/util';

const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_TERM = 200000;
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
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);

  const session = useRef<Session | null>(null);
  const utf8 = useRef(new Utf8Stream());
  const pending = useRef('');
  const ansiTail = useRef('');
  const scroll = useRef<ScrollView>(null);

  // Flush received text to the UI at ~10 Hz instead of per chunk.
  useEffect(() => {
    const t = setInterval(() => {
      if (pending.current === '') return;
      const add = pending.current;
      pending.current = '';
      setTerm((prev) => {
        const next = prev + add;
        return next.length > MAX_TERM ? next.slice(next.length - MAX_TERM / 2) : next;
      });
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

  useEffect(() => () => session.current?.stop(), []);

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
          <Button title={connected ? 'Disconnect' : 'Connect'} onPress={connect} />
        </View>
        <Text style={styles.status}>{status}</Text>
        <ScrollView
          ref={scroll}
          style={styles.term}
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        >
          <Text selectable style={styles.termText}>{term}</Text>
        </ScrollView>
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
          <Button title="Clr" onPress={() => setTerm('')} />
        </View>
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
});
