import { fileRoot } from '../agent/workspace.js';
import { userStorageSuffix } from '../core/userStorage.js';

export const nestFileScope = (server) => (server ? 'server' : 'local:' + fileRoot() + userStorageSuffix());
