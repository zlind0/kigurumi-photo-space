import { processFile } from './pipeline.js';
import type { ProcessRequest, WorkerMessage } from './types.js';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ProcessRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;

scope.addEventListener('message', (event) => {
  const { id, file, options } = event.data;
  void (async () => {
    try {
      const result = await processFile(id, file, options, (stage, message) => {
        scope.postMessage({ type: 'progress', id, stage, message } satisfies WorkerMessage);
      });
      scope.postMessage(result, [result.full, result.thumb]);
    } catch (error) {
      scope.postMessage({
        type: 'error',
        id,
        error: error instanceof Error ? error.message : String(error),
        code: 'PROCESS_FAILED',
      } satisfies WorkerMessage);
    }
  })();
});
