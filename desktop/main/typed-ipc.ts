// Typed registrar for invoke-style IPC handlers.
//
// `ipcMain.handle(channel, handler)` is structurally unchecked: the channel is
// a bare string and the handler may take any args and return anything. That
// made the typed IPC contract "vacuous on the result side" — a handler for
// `engine:pdfHealth` could return the wrong shape and nothing complained.
//
// `typedHandle(method, handler)` closes that gap. It is generic over the
// `ElectronAPI` method name, looks the channel up from the single-source
// `IPC_INVOKE` map (so the channel can't drift from the preload), and forces
// the handler body to honor the contract: it must accept exactly the method's
// parameters and resolve to the method's result type. Get either wrong and the
// build fails.
//
// `validate` runs per channel against the raw incoming args before the body —
// the seam for runtime arg checks (fs path-scoping, type guards). Throw from it
// to reject the invoke; the renderer's promise rejects with that error.

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_INVOKE, type ElectronAPI, type InvokeMethod } from '@shared/ipc';

type Awaitable<T> = T | Promise<T>;

/** The handler signature mandated for a given invoke method: receives the
 *  invoke event plus the method's declared parameters, and returns the
 *  method's resolved result (sync or async). */
export type TypedInvokeHandler<K extends InvokeMethod> = (
  event: IpcMainInvokeEvent,
  ...args: Parameters<ElectronAPI[K]>
) => Awaitable<Awaited<ReturnType<ElectronAPI[K]>>>;

/**
 * Register a contract-checked handler for an invoke channel.
 *
 * @param method   ElectronAPI method name; its channel is resolved from IPC_INVOKE.
 * @param handler  Body whose params/return are type-checked against ElectronAPI[method].
 * @param validate Optional runtime guard run on the raw args before the body;
 *                 throw to reject the invoke.
 */
export function typedHandle<K extends InvokeMethod>(
  method: K,
  handler: TypedInvokeHandler<K>,
  validate?: (args: Parameters<ElectronAPI[K]>) => void,
): void {
  ipcMain.handle(IPC_INVOKE[method], (event, ...rawArgs) => {
    const args = rawArgs as Parameters<ElectronAPI[K]>;
    if (validate) validate(args);
    return handler(event, ...args);
  });
}
