// Checks that an engine wasm module carries a "name" custom section (lib/CMakeLists.txt links Release builds with
// -g2), so trap and abort stack traces show function names instead of wasm-function[N]. Reads the section table
// without compiling the module.
const assert = require('node:assert/strict');
const fs = require('node:fs');

assert.ok(process.argv.length >= 3, 'Usage: node scripts/test_wasm_name_section.cjs <module.wasm>...');

function readULEB(bytes, offset) {
    let result = 0;
    let shift = 0;
    for (;;) {
        const byte = bytes[offset++];
        result += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) return [result, offset];
        shift += 7;
    }
}

function customSections(bytes) {
    assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'not a wasm module');
    const sections = new Map();
    let offset = 8;
    while (offset < bytes.length) {
        const id = bytes[offset++];
        let size;
        [size, offset] = readULEB(bytes, offset);
        const end = offset + size;
        if (id === 0) {
            const [nameLength, nameStart] = readULEB(bytes, offset);
            const name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString('utf8');
            sections.set(name, bytes.subarray(nameStart + nameLength, end));
        }
        offset = end;
    }
    return sections;
}

for (const file of process.argv.slice(2)) {
    const sections = customSections(new Uint8Array(fs.readFileSync(file)));
    const names = sections.get('name');
    assert.ok(names, `${file} has no "name" section (custom sections: ${[...sections.keys()].join(', ') || 'none'})`);
    // The function-name subsection must name the engine's exports, e.g. duckdb_web_connect.
    const text = Buffer.from(names).toString('latin1');
    assert.ok(text.includes('duckdb_web_connect'), `${file}: the name section does not name duckdb_web_connect`);
    console.log(`${file}: name section of ${names.length} bytes`);
}
