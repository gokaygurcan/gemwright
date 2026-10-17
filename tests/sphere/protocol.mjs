import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';

const [mode, host, portText, parameter = '0'] = process.argv.slice(2);
const port = Number(portText);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connect() {
  const socket = net.createConnection({ host, port });
  const state = { socket, buffer: Buffer.alloc(0), closed: false };
  socket.on('data', (data) => {
    state.buffer = Buffer.concat([state.buffer, data]);
  });
  socket.on('close', () => {
    state.closed = true;
  });
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return state;
}
async function until(connection, predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate(connection.buffer)) return connection.buffer;
    if (connection.closed) throw new Error(`Connection closed: ${connection.buffer.toString('hex')}`);
    await delay(25);
  }
  throw new Error(`Protocol timed out: ${connection.buffer.subarray(0, 80).toString('hex')}`);
}
const field = (value) => {
  const bytes = Buffer.alloc(30);
  bytes.write(value, 'ascii');
  return bytes;
};
const seed = Buffer.alloc(21);
seed[0] = 0xef;
[0x12345678, 7, 0, 74, 78].forEach((value, index) => seed.writeUInt32BE(value, 1 + index * 4));
const loginPacket = (password) =>
  Buffer.concat([Buffer.from([0x80]), field('admin'), field(password), Buffer.from([0])]);

function decode(input) {
  const codes = JSON.parse(readFileSync(new URL('./huffman.json', import.meta.url), 'utf8'));
  const root = {};
  codes.forEach((word, symbol) => {
    let node = root;
    for (let bit = (word & 15) - 1; bit >= 0; bit--) node = node[(word >> (bit + 4)) & 1] ??= {};
    node.symbol = symbol;
  });
  let node = root;
  const result = [];
  for (const byte of input) {
    for (let bit = 7; bit >= 0; bit--) {
      node = node[(byte >> bit) & 1];
      if (!node) throw new Error('Invalid Huffman response');
      if (node.symbol !== undefined) {
        if (node.symbol === 256) {
          node = root;
          break;
        }
        result.push(node.symbol);
        node = root;
      }
    }
  }
  return Buffer.from(result);
}

if (mode === 'login' || mode === 'wrong-password') {
  const connection = await connect();
  try {
    connection.socket.write(
      Buffer.concat([seed, loginPacket(mode === 'wrong-password' ? 'wrong-password' : 'Sphere-Password')])
    );
    await until(connection, (buffer) => buffer.length >= 2);
    if (mode === 'wrong-password') {
      assert.equal(connection.buffer[0], 0x82, 'Wrong credentials must be rejected');
      console.log('Wrong password rejected.');
    } else {
      await until(connection, (buffer) => buffer.length >= 3 && buffer.length >= buffer.readUInt16BE(1));
      assert.equal(connection.buffer[0], 0xa8, 'Expected server list');
      assert.ok(connection.buffer.readUInt16BE(4) >= 1);
      const selection = Buffer.alloc(3);
      selection[0] = 0xa0;
      selection.writeUInt16BE(connection.buffer.readUInt16BE(6), 1);
      connection.buffer = Buffer.alloc(0);
      connection.socket.write(selection);
      await until(connection, (buffer) => buffer.length >= 11);
      assert.equal(connection.buffer[0], 0x8c, 'Expected login relay');
      assert.deepEqual([...connection.buffer.subarray(1, 5)], [127, 0, 0, 1]);
      assert.equal(
        connection.buffer.readUInt16BE(5),
        Number(parameter),
        'Advertised port must be public, not application port'
      );
      console.log(JSON.stringify({ auth: connection.buffer.readUInt32BE(7) }));
    }
  } finally {
    connection.socket.destroy();
  }
} else if (mode === 'game') {
  const connection = await connect();
  try {
    const auth = Buffer.alloc(4);
    auth.writeUInt32BE(Number(parameter));
    connection.socket.write(Buffer.concat([auth, Buffer.from([0x91]), auth, field('admin'), field('Sphere-Password')]));
    const encoded = await until(connection, (buffer) => {
      if (buffer.length === 2 && buffer[0] === 0x82) throw new Error(`Game login rejected: ${buffer.toString('hex')}`);
      const plain = decode(buffer);
      return plain.length >= 8 && plain[0] === 0xb9 && plain[5] === 0xa9 && plain.length >= 5 + plain.readUInt16BE(6);
    });
    const plain = decode(encoded);
    assert.equal(plain[5], 0xa9);
    assert.equal(plain[8], 5, 'Expected five character slots from stock Sphere config');
    console.log('Game login reached a decoded character list.');
  } finally {
    connection.socket.destroy();
  }
} else if (mode === 'burst') {
  const connections = [];
  try {
    for (let index = 0; index < 12; index++) connections.push(await connect());
    for (const connection of connections) connection.socket.write(Buffer.from(' '));
    await Promise.all(
      connections.map((connection) => until(connection, (buffer) => buffer.toString().includes('Login:')))
    );
    console.log('Twelve simultaneous proxy-peer connections accepted.');
  } finally {
    for (const connection of connections) connection.socket.destroy();
  }
} else if (mode === 'set-state' || mode === 'check-state') {
  const expectedValue = Number(parameter) || 12345;
  const connection = await connect();
  try {
    connection.socket.write(Buffer.from(' '));
    await until(connection, (buffer) => buffer.toString().includes('Login:'));
    connection.buffer = Buffer.alloc(0);
    connection.socket.write('admin\r\n');
    await until(connection, (buffer) => buffer.toString().includes('Password:'));
    connection.buffer = Buffer.alloc(0);
    connection.socket.write('Sphere-Password\r\n');
    await delay(250);
    if (mode === 'set-state') {
      connection.socket.write(`VAR.gemwright_persistence=${expectedValue}\r\n`);
      await delay(200);
    }
    connection.buffer = Buffer.alloc(0);
    connection.socket.write('SHOW VAR.gemwright_persistence\r\n');
    await until(
      connection,
      (buffer) =>
        buffer
          .toString()
          .toLowerCase()
          .includes(`'0${expectedValue.toString(16)}'`) || buffer.toString().includes(`'${expectedValue}'`)
    );
    console.log('Persisted world variable verified through authenticated admin console.');
  } finally {
    connection.socket.destroy();
  }
} else throw new Error(`Unknown protocol mode ${mode}`);
