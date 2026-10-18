import * as duckdb from '../src/targets/duckdb';

type Listener = (event: any) => void;

/** A minimal stand-in for a Worker that answers requests via a callback */
class FakeWorker {
    readonly messages: any[] = [];
    terminated = false;
    private listeners = new Map<string, Set<Listener>>();

    constructor(protected readonly respond: (worker: FakeWorker, request: any) => void = () => {}) {}

    addEventListener(type: string, listener: Listener): void {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(listener);
    }

    removeEventListener(type: string, listener: Listener): void {
        this.listeners.get(type)?.delete(listener);
    }

    postMessage(message: any): void {
        this.messages.push(message);
        this.respond(this, message);
    }

    terminate(): void {
        this.terminated = true;
    }

    emit(type: string, event: any): void {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    }

    reply(request: any, type: duckdb.WorkerResponseType, data: any = null): void {
        this.emit('message', { data: { messageId: 0, requestId: request.messageId, type, data } });
    }
}

/** A worker that answers every request with OK after the given delay */
const okWorker = (delays: Partial<Record<duckdb.WorkerRequestType, number>> = {}) =>
    new FakeWorker((w, req) => {
        setTimeout(() => w.reply(req, duckdb.WorkerResponseType.OK), delays[req.type as duckdb.WorkerRequestType] ?? 0);
    });

const newDB = (worker: FakeWorker, options?: duckdb.AsyncDuckDBOptions) =>
    new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker as unknown as Worker, options);

export function testWorkerErrors(): void {
    describe('AsyncDuckDB worker failures', () => {
        let consoleError: jasmine.Spy;
        beforeEach(() => {
            // The failure paths log loudly on purpose; keep the test output readable.
            consoleError = spyOn(console, 'error');
            spyOn(console, 'warn');
        });

        it('rejects pending requests when the worker emits an error', async () => {
            const worker = new FakeWorker();
            const db = newDB(worker, { workerStartTimeout: 0 });
            const pending = db.instantiate('main.wasm');
            const other = db.getVersion();
            worker.emit('error', { message: 'boom' });
            await expectAsync(pending).toBeRejectedWithError(/error in duckdb worker: boom/);
            await expectAsync(other).toBeRejectedWithError(/error in duckdb worker: boom/);
            expect(consoleError).toHaveBeenCalled();
        });

        it('rejects pending requests when a message cannot be deserialized', async () => {
            const worker = new FakeWorker();
            const db = newDB(worker, { workerStartTimeout: 0 });
            const pending = db.ping();
            worker.emit('messageerror', {});
            await expectAsync(pending).toBeRejectedWithError(/could not be deserialized/);
        });

        it('rejects pending requests on terminate', async () => {
            const worker = new FakeWorker();
            const db = newDB(worker, { workerStartTimeout: 0 });
            const pending = db.instantiate('main.wasm');
            await db.terminate();
            expect(worker.terminated).toBeTrue();
            await expectAsync(pending).toBeRejectedWithError(/terminated/);
        });

        it('rejects pending requests on detach', async () => {
            const worker = new FakeWorker();
            const db = newDB(worker, { workerStartTimeout: 0 });
            const pending = db.instantiate('main.wasm');
            db.detach();
            await expectAsync(pending).toBeRejectedWithError(/detached/);
        });

        it('rejects instantiate when the worker never starts', async () => {
            const worker = new FakeWorker(); // never answers
            const db = newDB(worker, { workerStartTimeout: 50 });
            const started = Date.now();
            await expectAsync(db.instantiate('main.wasm')).toBeRejectedWithError(/worker did not start/);
            expect(Date.now() - started).toBeLessThan(5000);
            // The liveness ping went out before the real request
            expect(worker.messages.map(m => m.type)).toEqual([
                duckdb.WorkerRequestType.PING,
                duckdb.WorkerRequestType.INSTANTIATE,
            ]);
        });

        it('does not time out a started worker that is slow to instantiate', async () => {
            const worker = okWorker({ [duckdb.WorkerRequestType.INSTANTIATE]: 300 });
            const db = newDB(worker, { workerStartTimeout: 50 });
            await expectAsync(db.instantiate('main.wasm')).toBeResolved();
            // Only one liveness ping per worker
            await db.ping();
            expect(worker.messages.filter(m => m.type == duckdb.WorkerRequestType.PING).length).toEqual(2);
        });

        it('sends no liveness ping when the check is disabled', async () => {
            const worker = okWorker();
            const db = newDB(worker, { workerStartTimeout: 0 });
            await db.instantiate('main.wasm');
            expect(worker.messages.map(m => m.type)).toEqual([duckdb.WorkerRequestType.INSTANTIATE]);
        });
    });
}
