export type SaveLocation = 'source-folder' | 'chosen-folder' | 'downloads';

export type PreparedBlobSaver = {
  location: SaveLocation;
  startIn?: FileSystemDirectoryHandle | FileSystemFileHandle;
  save: (blob: Blob) => Promise<void>;
};

export type DirectoryBlob = {
  fileName: string;
  blob: Blob;
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
    startIn?: FileSystemDirectoryHandle | FileSystemFileHandle;
  }) => Promise<FileSystemFileHandle>;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function nextAvailableFileName(
  directory: FileSystemDirectoryHandle,
  preferredName: string,
): Promise<string> {
  const extensionIndex = preferredName.lastIndexOf('.');
  const extension = extensionIndex > 0 ? preferredName.slice(extensionIndex) : '';
  const stem = extension ? preferredName.slice(0, -extension.length) : preferredName;
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

export async function saveBlobsToDirectory(
  directory: FileSystemDirectoryHandle,
  files: DirectoryBlob[],
): Promise<void> {
  for (const { fileName, blob } of files) {
    const availableName = await nextAvailableFileName(directory, fileName);
    const fileHandle = await directory.getFileHandle(availableName, { create: true });
    await writeBlob(fileHandle, blob);
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
  preferredStartIn?: FileSystemDirectoryHandle | FileSystemFileHandle | null,
): Promise<PreparedBlobSaver> {
  if (sourceDirectory) {
    const availableName = await nextAvailableFileName(sourceDirectory, fileName);
    return {
      location: 'source-folder',
      startIn: sourceDirectory,
      save: async (blob) => {
        const fileHandle = await sourceDirectory.getFileHandle(availableName, { create: true });
        await writeBlob(fileHandle, blob);
      },
    };
  }

  const savePickerWindow = window as unknown as SavePickerWindow;
  if (typeof savePickerWindow.showSaveFilePicker === 'function') {
    try {
      const startIn = preferredStartIn ?? sourceFile;
      const fileHandle = await savePickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: [
          {
            description: options.description,
            accept: { [options.mimeType]: [options.extension] },
          },
        ],
        ...(startIn ? { startIn } : {}),
      });
      return {
        location: 'chosen-folder',
        startIn: fileHandle,
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
