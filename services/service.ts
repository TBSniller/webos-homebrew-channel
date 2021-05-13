import fs from 'fs';
import { createHash } from 'crypto';
import fetch from 'node-fetch';
import path from 'path';
import child_process from 'child_process';

// @ts-ignore
import { Promise } from 'bluebird';
import progress from 'progress-stream';
import Service, { Message } from 'webos-service';

import rootAppInfo from '../appinfo.json';
import serviceInfo from './services.json';
import { asyncAccess, asyncExecFile, asyncPipeline, asyncUnlink, asyncWriteFile } from './adapter';
import { makeError, makeSuccess } from './protocol';
import ServiceRemote from './webos-service-remote';

const kHomebrewChannelPackageId = rootAppInfo.id;

const service = new Service(serviceInfo.id);
const serviceRemote = new ServiceRemote(service);

function runningAsRoot() {
  return process.getuid() === 0;
}

function getInstallerService(): Service {
  if (runningAsRoot()) {
    return service;
  }
  return serviceRemote as Service;
}

// Maps internal setting field name with filesystem flag name.
type FlagName = string;
const availableFlags = {
  telnetDisabled: 'webosbrew_telnet_disabled',
  failsafe: 'webosbrew_failsafe',
  sshdEnabled: 'webosbrew_sshd_enabled',
  blockUpdates: 'webosbrew_block_updates',
} as Record<string, FlagName>;

function asyncCall<T extends Record<string, any>>(srv: Service, uri: string, args: Record<string, any>): Promise<T> {
  return new Promise((resolve, reject) => {
    srv.call(uri, args, ({ payload }) => {
      if (payload.returnValue) {
        resolve(payload as T);
      } else {
        reject(payload);
      }
    });
  });
}

function createToast(message: string): Promise<Record<string, any>> {
  return asyncCall(service, 'luna://com.webos.notification/createToast', {
    sourceId: serviceInfo.id,
    message,
  });
}

/**
 * Generates local file checksum.
 */
async function hashFile(filePath: string, algorithm: string): Promise<string> {
  const download = fs.createReadStream(filePath);
  const hash = createHash(algorithm, { encoding: 'hex' });
  await asyncPipeline(download, hash);
  return hash.read();
}

/**
 * Elevates a package by name.
 */
async function elevateService(pkg: string) {
  if (runningAsRoot()) {
    console.info('Elevating service...');
    await asyncExecFile(path.join(__dirname, 'elevate-service'), [pkg]);
  } else {
    console.error('Trying to elevate service without running as root. Skipping.');
  }
}

/**
 * Returns the file path for a flag.
 */
function flagPath(flag: FlagName): string {
  return `/var/luna/preferences/${flag}`;
}

/**
 * Returns whether a flag is set or not.
 */
async function flagRead(flag: FlagName): Promise<boolean> {
  try {
    await asyncAccess(flagPath(flag));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Sets the value of a flag.
 */
async function flagSet(flag: FlagName, enabled: boolean) {
  if (enabled) {
    // The file content is ignored, file presence is what matters. Writing '1' acts as a hint.
    await asyncWriteFile(flagPath(flag), '1');
  } else {
    try {
      await asyncUnlink(flagPath(flag));
    } catch (err) {
      // Already deleted is not a fatal error.
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return flagRead(flag);
}

/**
 * Performs appInstallService/dev/install request.
 */
async function installPackage(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = getInstallerService().subscribe('luna://com.webos.appInstallService/dev/install', {
      id: 'testing',
      ipkUrl: filePath,
      subscribe: true,
    });
    req.on('response', (res) => {
      console.info('appInstallService response:', res.payload);

      if (res.payload.returnValue === false) {
        reject(new Error(`${res.payload.errorCode}: ${res.payload.errorText}`));
        req.cancel();
        return;
      }

      if (res.payload.details && res.payload.details.errorCode !== undefined) {
        reject(new Error(`${res.payload.details.errorCode}: ${res.payload.details.reason}`));
        req.cancel();
        return;
      }

      if (res.payload.statusValue === 30) {
        resolve(res.payload.details.packageId);
        req.cancel();
      }
    });
    req.on('cancel', (msg) => {
      if (msg.payload && msg.payload.errorText) {
        reject(new Error(msg.payload.errorText));
      } else {
        reject(new Error('cancelled'));
      }
    });
  });
}

/**
 * Thin wrapper that responds with a successful message or an error in case of a JS exception.
 */
function tryRespond<T extends Record<string, any>>(runner: (message: Message) => T) {
  return async (message: Message): Promise<void> => {
    try {
      const reply: T = await runner(message);
      message.respond(makeSuccess(reply));
    } catch (err) {
      message.respond(makeError(err.toString()));
    } finally {
      message.cancel({});
    }
  };
}

/**
 * Installs the requested ipk from a URL.
 */
type InstallPayload = { ipkUrl: string; ipkHash: string };
service.register(
  'install',
  tryRespond(async (message: Message) => {
    const payload = message.payload as InstallPayload;
    const targetPath = `/tmp/.hbchannel-incoming-${Date.now()}.ipk`;

    // Download
    message.respond({ statusText: 'Downloading…' });
    const res = await fetch(payload.ipkUrl);
    if (!res.ok) {
      throw new Error(res.statusText);
    }
    const progressReporter = progress({
      length: parseInt(res.headers.get('content-length'), 10),
      time: 300 /* ms */,
    });
    progressReporter.on('progress', (p) => {
      message.respond({ statusText: 'Downloading…', progress: p.percentage });
    });
    const targetFile = fs.createWriteStream(targetPath);
    await asyncPipeline(res.body, progressReporter, targetFile);

    // Checksum
    message.respond({ statusText: 'Verifying…' });
    const checksum = await hashFile(targetPath, 'sha256');
    if (checksum !== payload.ipkHash) {
      throw new Error('Invalid file checksum');
    }

    // Install
    message.respond({ statusText: 'Installing…' });
    const installedPackageId = await installPackage(targetPath);

    await createToast(`Application installed: ${installedPackageId}`);

    // Special-case the privileged Homebrew Channel core app.
    if (installedPackageId === kHomebrewChannelPackageId) {
      await elevateService(installedPackageId);
      service.activityManager.idleTimeout = 1;
      await createToast('Homebrew Channel update finished');
    }

    return { statusText: 'Finished.', finished: true };
  }),
  () => {
    // TODO: support cancellation.
  },
);

/**
 * Returns the current value of all available flags, plus whether we're running as root.
 */
service.register(
  'getConfiguration',
  tryRespond(async () => {
    const futureFlags = Object.entries(availableFlags).map(
      async ([field, flagName]) => [field, await flagRead(flagName)] as [string, boolean],
    );
    const flags = Object.fromEntries(await Promise.all(futureFlags));
    return {
      root: process.getuid() === 0,
      ...flags,
    };
  }),
);

/**
 * Sets any of the available flags.
 */
type SetConfigurationPayload = Record<string, boolean>;
service.register(
  'setConfiguration',
  tryRespond(async (message) => {
    const payload = message.payload as SetConfigurationPayload;
    const futureFlagSets = Object.entries(payload)
      .map(([field, value]) => [field, availableFlags[field], value] as [string, FlagName | undefined, boolean])
      .filter(([, flagName]) => flagName !== undefined)
      .map(async ([field, flagName, value]) => [field, await flagSet(flagName, value)]);
    return Object.fromEntries(await Promise.all(futureFlagSets));
  }),
);

/**
 * Invokes a platform reboot.
 */
service.register(
  'reboot',
  tryRespond(async () => {
    await asyncExecFile('reboot');
  }),
);

/**
 * Returns whether the service is running as root.
 */
service.register(
  'checkRoot',
  tryRespond(async () => runningAsRoot()),
);

/**
 * Roughly replicates com.webos.applicationManager/getAppInfo request in an
 * environment-independent way (non-root vs root).
 */
type GetAppInfoPayload = { id: string };
service.register(
  'getAppInfo',
  tryRespond(async (message) => {
    const payload = message.payload as GetAppInfoPayload;
    const appId: string = payload.id;
    if (!appId) throw new Error('missing `id` string field');
    const appList = await asyncCall<{ apps: { id: string }[] }>(
      getInstallerService(),
      'luna://com.webos.applicationManager/dev/listApps',
      {},
    );
    const appInfo = appList.apps.find((app) => app.id === appId);
    if (!appInfo) throw new Error(`Invalid appId, or unsupported application type: ${appId}`);
    return { appId, appInfo };
  }),
);

/**
 * Executes a shell command and responds with exit code, stdout and stderr.
 */
type ExecPayload = { command: string };
service.register('exec', (message) => {
  const payload = message.payload as ExecPayload;
  child_process.exec(payload.command, { encoding: 'buffer' }, (error, stdout, stderr) => {
    const response = {
      error,
      stdoutString: stdout.toString(),
      stdoutBytes: stdout.toString('base64'),
      stderrString: stderr.toString(),
      stderrBytes: stderr.toString('base64'),
    };
    if (error) {
      message.respond(makeError(error.message, response));
    } else {
      message.respond(makeSuccess(response));
    }
  });
});

/**
 * Spawns a shell command and streams stdout & stderr bytes.
 */
service.register('spawn', (message) => {
  const payload = message.payload as ExecPayload;
  const respond = (event: string, args: Record<string, any>) => message.respond({ event, ...args });
  const proc = child_process.spawn('/bin/sh', ['-c', payload.command]);
  proc.stdout.on('data', (data) =>
    respond('stdoutData', {
      stdoutString: data.toString(),
      stdoutBytes: data.toString('base64'),
    }),
  );
  proc.stderr.on('data', (data) =>
    respond('stderrData', {
      stderrString: data.toString(),
      stderrBytes: data.toString('base64'),
    }),
  );
  proc.on('close', (closeCode) => respond('close', { closeCode }));
  proc.on('exit', (exitCode) => respond('exit', { exitCode }));
});

/**
 * Stub service that emulates luna://com.webos.service.sm/license/apps/getDrmStatus
 */
type GetDrmStatusPayload = { appId: string };
service.register(
  'getDrmStatus',
  tryRespond(async (message) => ({
    appId: (message.payload as GetDrmStatusPayload).appId,
    drmType: 'NCG DRM',
    installBasePath: '/media/cryptofs',
    returnValue: true,
    isTimeLimited: false,
  })),
);
