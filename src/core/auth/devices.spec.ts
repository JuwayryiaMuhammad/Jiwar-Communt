import { classifyUserAgent, deviceIdentity } from './devices';

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  firefoxLinux:
    'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  app: 'Jiwar/1.4.0 (Android 14; Pixel 8)',
};

describe('devices', () => {
  it('reads the OS and the browser family, nothing finer', () => {
    expect(classifyUserAgent(UA.chromeWindows)).toEqual({
      os: 'windows',
      browser: 'chrome',
      mobile: false,
    });
    expect(classifyUserAgent(UA.edgeWindows).browser).toBe('edge');
    expect(classifyUserAgent(UA.safariMac)).toEqual({
      os: 'macos',
      browser: 'safari',
      mobile: false,
    });
    expect(classifyUserAgent(UA.safariIphone)).toEqual({
      os: 'ios',
      browser: 'safari',
      mobile: true,
    });
    expect(classifyUserAgent(UA.chromeAndroid)).toEqual({
      os: 'android',
      browser: 'chrome',
      mobile: true,
    });
    expect(classifyUserAgent(UA.firefoxLinux).browser).toBe('firefox');
    expect(classifyUserAgent(undefined)).toEqual({
      os: 'other',
      browser: 'other',
      mobile: false,
    });
  });

  it('an app is its install id; a browser is its family and OS', () => {
    const install = '0192a5f0-1c2b-7d3e-8f40-123456789abc';
    expect(deviceIdentity(UA.app, install)).toEqual({
      source: 'app',
      material: install,
      deviceType: 'android',
    });
    expect(deviceIdentity(UA.app, install.toUpperCase()).material).toBe(
      install,
    );
    // Two Chrome versions on Windows are the same browser.
    expect(deviceIdentity(UA.chromeWindows, undefined)).toEqual({
      source: 'web',
      material: 'chrome/windows',
      deviceType: 'desktop_web',
    });
    expect(deviceIdentity(UA.safariIphone, null).deviceType).toBe('mobile_web');
    expect(deviceIdentity(undefined, undefined)).toEqual({
      source: 'web',
      material: 'other/other',
      deviceType: 'unknown',
    });
  });

  it('a malformed install id counts as none', () => {
    expect(deviceIdentity(UA.chromeAndroid, 'not-a-uuid')).toMatchObject({
      source: 'web',
      material: 'chrome/android',
    });
  });
});
