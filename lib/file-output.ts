export type SaveLocation = 'source-folder' | 'chosen-folder' | 'downloads';

export type PreparedBlobSaver = {
  location: SaveLocation;
  save: (blob: Blob) => Promise<void>;
};

type SaveOptions = {
  description: string;
  mimeType: string;
  extension: string;
};

type SavePickerWindow = Window & {
  showSaveFilePicker: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
    startIn?: FileSystemFileHandle;
  }) => Promise<FileSystemFileHandle>;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function nextAvailableFileName(
  directory: FileSystemDirectoryHandle,
  preferredName: string,
): Promise<string> {
  const extension = preferredName.toLowerCase().endsWith('.zip') ? '.zip' : '.pdf';
  const stem = preferredName.slice(0, -extension.length);
  let candidate = preferredName;
  let suffix = 2;

  while (true) {
    try {
      await directory.getFileHandle(candidate);
      candidate = `${stem}_${suffix}${extension}`;
      suffix += 1;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return candidate;
      throw error;
    }
  }
}

async function writeBlob(fileHandle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // The original write error is more useful to the caller.
    }
    throw error;
  }
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = Object.assign(document.createElement('a'), {
    href: url,
    download: fileName,
  });
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function prepareBlobSaver(
  fileName: string,
  options: SaveOptions,
  sourceDirectory?: FileSystemDirectoryHandle | null,
  sourceFile?: FileSystemFileHandle | null,
): Promise<PreparedBlobSaver> {
  if (sourceDirectory) {
    const availableName = await nextAvailableFileName(sourceDirectory, fileName);
    return {
      location: 'source-folder',
      save: async (blob) => {
        const fileHandle = await sourceDirectory.getFileHandle(availableName, { create: true });
        await writeBlob(fileHandle, blob);
      },
    };
  }

  const savePickerWindow = window as unknown as SavePickerWindow;
  if (typeof savePickerWindow.showSaveFilePicker === 'function') {
    try {
      const fileHandle = await savePickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: [
          {
            description: options.description,
            accept: { [options.mimeType]: [options.extension] },
          },
        ],
        ...(sourceFile ? { startIn: sourceFile } : {}),
      });
      return {
        location: 'chosen-folder',
        save: (blob) => writeBlob(fileHandle, blob),
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new Error('저장 위치에 파일을 만들지 못했습니다. 폴더 권한을 확인해 주세요.');
    }
  }

  return {
    location: 'downloads',
    save: async (blob) => triggerDownload(blob, fileName),
  };
}

export function isSavePickerCancelled(error: unknown): boolean {
  return isAbortError(error);
}
