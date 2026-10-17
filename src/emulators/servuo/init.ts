import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as prompts from '@clack/prompts';

import type { ShardConfig } from '../../config';
import { answer } from '../../prompts';
import { generatedOwnerPassword, validateOwner, validateOwnerPassword } from '../accounts';
import { configValue, fetchServuoConfig, prepareServuoFiles, type ServuoSettings } from './config';

export async function initializeServuo(config: ShardConfig, yes = false, loadConfig = fetchServuoConfig) {
  let generatedPassword: string | undefined;

  const upstream = await loadConfig(config.source!);
  const registration = configValue(upstream['Config/Accounts.cfg'] ?? '', 'AutoCreateAccounts');
  if (!registration || !/^(true|false)$/i.test(registration))
    throw new Error('Upstream automatic registration default is missing or invalid.');
  const clientFiles = yes
    ? ''
    : answer(
        await prompts.text({
          message: 'UO client files directory (optional; leave blank to add at deploy)',
          validate: async (value) => {
            if (!value) return;
            try {
              if (!(await stat(resolve(value))).isDirectory()) return 'Choose a directory.';
            } catch {
              return 'That directory does not exist.';
            }
          }
        })
      );
  const autoCreateAccounts = yes
    ? registration.toLowerCase() === 'true'
    : answer(
        await prompts.confirm({
          message: 'Allow players to create accounts on first login?',
          initialValue: registration.toLowerCase() === 'true'
        })
      );
  const owner = yes
    ? 'admin'
    : answer(
        await prompts.text({
          message: 'Owner username',
          placeholder: 'admin',
          defaultValue: 'admin',
          validate: (value) => validateOwner(value || 'admin')
        })
      );
  let password = yes
    ? ''
    : answer(
        await prompts.password({
          message: 'Owner password (leave blank to generate)',
          validate: (value) => validateOwnerPassword(value ?? '')
        })
      );
  if (!password) password = generatedPassword = generatedOwnerPassword();
  const settings: ServuoSettings = {
    ...(clientFiles ? { clientFiles: resolve(clientFiles) } : {}),
    autoCreateAccounts,
    owner
  };
  return { settings, files: prepareServuoFiles(upstream, config, settings, password), generatedPassword };
}
