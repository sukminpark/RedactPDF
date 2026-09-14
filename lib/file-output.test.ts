import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareBlobSaver, saveBlobsToDirectory } from './file-output';

const saveOptions = {
  description: 'PDF 파일',
  mimeType: 'application/pdf',
  extension: '.pdf',
};

function createFileHandle() {
  const writable = {
    write: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  return {
    createWritable: vi.fn(async () => writable),
    writable,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prepareBlobSaver', () => {
  it('writes to the selected source folder with a unique output name', async () => {
    const fileHandle = createFileHandle();
    const getFileHandle = vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!options?.create && name === '결과.pdf') return {} as FileSystemFileHandle;
      if (options?.create && name === '결과_2.pdf') return fileHandle;
      throw new DOMException('파일이 없습니다.', 'NotFoundError');
    });
    const directory = { getFileHandle } as unknown as FileSystemDirectoryHandle;

    const saver = await prepareBlobSaver('결과.pdf', saveOptions, directory);
    await saver.save(new Blob(['pdf'], { type: 'application/pdf' }));

    expect(saver.location).toBe('source-folder');
    expect(saver.startIn).toBe(directory);
    expect(getFileHandle).toHaveBeenLastCalledWith('결과_2.pdf', { create: true });
    expect(fileHandle.writable.write).toHaveBeenCalledOnce();
    expect(fileHandle.writable.close).toHaveBeenCalledOnce();
  });

  it('opens the save picker with the original file as its starting location', async () => {
    const fileHandle = createFileHandle();
    const sourceFile = {} as FileSystemFileHandle;
    const showSaveFilePicker = vi.fn(async () => fileHandle);
    vi.stubGlobal('window', { showSaveFilePicker });

    const saver = await prepareBlobSaver('결과.pdf', saveOptions, null, sourceFile);
    await saver.save(new Blob(['pdf'], { type: 'application/pdf' }));

    expect(saver.location).toBe('chosen-folder');
    expect(saver.startIn).toBe(fileHandle);
    expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({
      suggestedName: '결과.pdf',
      startIn: sourceFile,
    }));
    expect(fileHandle.writable.write).toHaveBeenCalledOnce();
  });

  it('prefers the remembered save location for later downloads', async () => {
    const fileHandle = createFileHandle();
    const rememberedFolder = {} as FileSystemDirectoryHandle;
    const showSaveFilePicker = vi.fn(async () => fileHandle);
    vi.stubGlobal('window', { showSaveFilePicker });

    await prepareBlobSaver('결과.pdf', saveOptions, null, null, rememberedFolder);

    expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({
      startIn: rememberedFolder,
    }));
  });
});

describe('saveBlobsToDirectory', () => {
  it('writes each output without overwriting files with the same name', async () => {
    const existingNames = new Set<string>();
    const handles = new Map<string, ReturnType<typeof createFileHandle>>();
    const getFileHandle = vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!options?.create) {
        if (existingNames.has(name)) return {} as FileSystemFileHandle;
        throw new DOMException('파일이 없습니다.', 'NotFoundError');
      }
      existingNames.add(name);
      const handle = createFileHandle();
      handles.set(name, handle);
      return handle;
    });
    const directory = { getFileHandle } as unknown as FileSystemDirectoryHandle;

    await saveBlobsToDirectory(directory, [
      { fileName: '결과.pdf', blob: new Blob(['first']) },
      { fileName: '결과.pdf', blob: new Blob(['second']) },
    ]);

    expect(handles.get('결과.pdf')?.writable.write).toHaveBeenCalledOnce();
    expect(handles.get('결과_2.pdf')?.writable.write).toHaveBeenCalledOnce();
  });
});
