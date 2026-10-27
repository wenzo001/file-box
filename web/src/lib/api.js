// 相对站点根目录拼 API：页面在 / 或反向代理子路径 /box/ 下都能用。
const API_ROOT = new URL('../api/', document.baseURI).href;

async function request(path, options = {}) {
  const res = await fetch(new URL(path, API_ROOT), options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

const json = (path, method, body, options = {}) => request(path, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  ...options,
});

const q = (value) => encodeURIComponent(String(value));

export const api = {
  library: () => request('library'),
  uploads: () => request('uploads'),
  settings: () => request('settings'),
  saveSettings: (settings) => json('settings', 'PUT', settings),

  createFolder: (name, parentId) => json('folders', 'POST', { name, parentId }),
  patchFolder: (id, patch) => json(`folders/${q(id)}`, 'PATCH', patch),
  deleteFolder: (id, mode) => request(`folders/${q(id)}${mode === 'empty' ? '?mode=empty' : ''}`, { method: 'DELETE' }),

  moveBatch: (batch, folderId) => json(`batches/${q(batch)}`, 'PATCH', { folderId }),
  moveBatches: (names, folderId) => json('batches', 'PATCH', { names, folderId }),
  deleteBatch: (batch, expectFolder) => {
    const expect = expectFolder === undefined ? '' : `?expectFolder=${q(expectFolder ?? '__unfiled__')}`;
    return request(`folder/${q(batch)}${expect}`, { method: 'DELETE' });
  },

  deleteFile: (batch, body) => json(`batches/${q(batch)}/file-delete`, 'POST', body),
  renameFile: (batch, body) => json(`batches/${q(batch)}/file-rename`, 'POST', body),

  uploadInit: (body) => json('upload/init', 'POST', body),
  uploadFinish: (uploadId) => json('upload/finish', 'POST', { uploadId }),
  cancelUpload: (id) => request(`uploads/${q(id)}`, { method: 'DELETE' }),
  uploadPart: (uploadId, fi, ci, body, crc, signal) => fetch(
    new URL(`upload/part?u=${q(uploadId)}&f=${fi}&c=${ci}`, API_ROOT),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Crc': crc },
      body,
      signal,
    },
  ),

  downloadUrl: (batch, file) => new URL(`download/${q(batch)}/${q(file)}`, API_ROOT).href,
};

export { API_ROOT };
