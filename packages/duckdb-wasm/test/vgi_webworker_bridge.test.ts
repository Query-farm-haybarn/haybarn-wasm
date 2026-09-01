import { installVgiWebWorkerBridge } from '../src/vgi/webworker-bridge';

type Listener = (event: MessageEvent) => void;

class FakeWorker {
    static instances: FakeWorker[] = [];
    readonly messages: Array<Record<string, unknown>> = [];
    private listeners = new Set<Listener>();

    constructor(readonly url: string) {
        FakeWorker.instances.push(this);
    }

    addEventListener(type: string, listener: EventListener): void {
        if (type === 'message') this.listeners.add(listener as Listener);
    }

    removeEventListener(type: string, listener: EventListener): void {
        if (type === 'message') this.listeners.delete(listener as Listener);
    }

    postMessage(message: Record<string, unknown>): void {
        this.messages.push(message);
        if (message.type === 'vgi-init') queueMicrotask(() => this.emit({ type: 'vgi-ready' }));
        if (message.type === 'vgi-register-target') {
            queueMicrotask(() => this.emit({ type: 'vgi-target-ready', requestId: message.requestId }));
        }
    }

    terminate(): void {
        // no-op
    }

    private emit(data: Record<string, unknown>): void {
        const event = { data } as MessageEvent;
        for (const listener of [...this.listeners]) listener(event);
    }
}

class FakeDuckDbWorker {
    private listener?: Listener;

    addEventListener(type: string, listener: EventListener): void {
        if (type === 'message') this.listener = listener as Listener;
    }

    ensure(location: string, buffer: SharedArrayBuffer, offset = 0): SharedArrayBuffer {
        const readySab = new SharedArrayBuffer(8);
        this.listener?.({
            data: { type: 'vgi-ensure-worker', location, buffer, offset, readySab },
        } as MessageEvent);
        return readySab;
    }
}

function region(state = 0): SharedArrayBuffer {
    const buffer = new SharedArrayBuffer(128);
    const i32 = new Int32Array(buffer);
    i32[2] = 1; // n_slots
    i32[4] = 64; // slot_stride
    i32[5] = 64; // slots_off
    i32[16] = state; // slot[0].STATE
    return buffer;
}

async function readyValue(readySab: SharedArrayBuffer): Promise<number> {
    const ready = new Int32Array(readySab);
    for (let i = 0; i < 100 && Atomics.load(ready, 0) === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    return Atomics.load(ready, 0);
}

export function testVgiWebWorkerBridge(): void {
    describe('VGI multi-target WebWorker bridge', () => {
        const priorWorker = (globalThis as unknown as { Worker?: unknown }).Worker;
        const priorSelf = (globalThis as unknown as { self?: unknown }).self;

        beforeEach(() => {
            FakeWorker.instances = [];
            (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
            (globalThis as unknown as { self: unknown }).self = {
                location: { href: 'https://example.test/app/', origin: 'https://example.test' },
            };
        });

        afterEach(() => {
            (globalThis as unknown as { Worker?: unknown }).Worker = priorWorker;
            (globalThis as unknown as { self?: unknown }).self = priorSelf;
        });

        it('registers two target regions with one stable adapter worker', async () => {
            const install = installVgiWebWorkerBridge({
                resolveWorkerUrl: url => url,
                resolveAdapterTarget: location => ({
                    adapterUrl: 'https://example.test/iroh-adapter.js',
                    adapterKey: 'iroh-v1',
                    canonicalTarget: `iroh:${location}`,
                }),
            });
            const duck = new FakeDuckDbWorker();
            install(duck as unknown as Worker);

            const first = duck.ensure('node-a', region());
            expect(await readyValue(first)).toBe(1);
            const second = duck.ensure('node-b', region());
            expect(await readyValue(second)).toBe(1);

            expect(FakeWorker.instances.length).toBe(1);
            expect(FakeWorker.instances[0].messages.map(m => m.type)).toEqual(['vgi-init', 'vgi-register-target']);
        });

        it('preserves resolveWorkerUrl as a one-worker legacy path', async () => {
            const install = installVgiWebWorkerBridge({ resolveWorkerUrl: () => 'https://example.test/worker.js' });
            const duck = new FakeDuckDbWorker();
            install(duck as unknown as Worker);

            expect(await readyValue(duck.ensure('worker:a', region()))).toBe(1);
            expect(await readyValue(duck.ensure('worker:a', region()))).toBe(1);
            expect(FakeWorker.instances.length).toBe(1);
            expect(FakeWorker.instances[0].messages.map(m => m.type)).toEqual(['vgi-init']);
        });

        it('refuses to reclaim an active region and reclaims it after release', async () => {
            const install = installVgiWebWorkerBridge({
                resolveWorkerUrl: url => url,
                resolveAdapterTarget: location => ({
                    adapterUrl: 'https://example.test/iroh-adapter.js',
                    adapterKey: 'iroh-v1',
                    canonicalTarget: `iroh:${location}`,
                }),
                maxTargetsPerAdapter: 1,
            });
            const duck = new FakeDuckDbWorker();
            install(duck as unknown as Worker);

            const firstRegion = region(1);
            expect(await readyValue(duck.ensure('node-a', firstRegion))).toBe(1);
            expect(await readyValue(duck.ensure('node-b', region()))).toBe(-1);

            Atomics.store(new Int32Array(firstRegion), 16, 0);
            expect(await readyValue(duck.ensure('node-b', region()))).toBe(1);
            expect(FakeWorker.instances[0].messages.map(m => m.type)).toEqual([
                'vgi-init',
                'vgi-unregister-target',
                'vgi-register-target',
            ]);
        });
    });
}
