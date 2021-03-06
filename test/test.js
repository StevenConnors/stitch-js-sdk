/* global expect, it, describe, global, afterEach, beforeEach, afterAll, beforeAll, require, Buffer, Promise */
const fetchMock = require('fetch-mock');
const URL = require('url-parse');
import StitchClient from '../src/client';
import { JSONTYPE, DEFAULT_STITCH_SERVER_URL } from '../src/common';
import { REFRESH_TOKEN_KEY } from '../src/auth/common';
import Auth from '../src/auth';
import { mocks } from 'mock-browser';
import ExtJSON from 'mongodb-extjson';

const ANON_AUTH_URL = 'https://stitch.mongodb.com/api/client/v2.0/app/testapp/auth/providers/anon-user/login';
const APIKEY_AUTH_URL = 'https://stitch.mongodb.com/api/client/v2.0/app/testapp/auth/providers/api-key/login';
const LOCALAUTH_URL = 'https://stitch.mongodb.com/api/client/v2.0/app/testapp/auth/providers/local-userpass/login';
const FUNCTION_CALL_URL = 'https://stitch.mongodb.com/api/client/v2.0/app/testapp/functions/call';
const SESSION_URL = 'https://stitch.mongodb.com/api/client/v2.0/auth/session';
const PROFILE_URL = 'https://stitch.mongodb.com/api/client/v2.0/auth/profile';

const MockBrowser = mocks.MockBrowser;
global.Buffer = global.Buffer || require('buffer').Buffer;

const hexStr = '5899445b275d3ebe8f2ab8c0';
const mockDeviceId = '8773934448abcdef12345678';

const sampleProfile = {
  user_id: '8a15d6d20584297fa336becf',
  domain_id: '8a156a044fdd1fa5045accab',
  identities:
  [
    {
      id: '8a15d6d20584297fa336bece-gkyglweqvueqoypkwanpaaca',
      provider_type: 'anon-user',
      provider_id: '8a156a5b0584299f47a1c6fd'
    }
  ],
  data: {},
  type: 'normal'
};

const mockBrowserHarness = {
  setup() {
    const mb = new MockBrowser();
    global.window = mb.getWindow();
  },

  teardown() {
    global.window = undefined;
  }
};

const envConfigs = [
  {
    name: 'with window.localStorage',
    setup: mockBrowserHarness.setup,
    teardown: mockBrowserHarness.teardown
  },
  {
    name: 'without window.localStorage',
    setup: () => {},
    teardown: () => {}
  }
];

describe('Redirect fragment parsing', () => {
  const makeFragment = (parts) => (
    Object.keys(parts).map(
      (key) => (encodeURIComponent(key) + '=' + parts[key])
    ).join('&')
  );

  const a = new Auth(null, '/auth');
  it('should detect valid states', () => {
    let result = a.parseRedirectFragment(makeFragment({'_stitch_state': 'state_XYZ'}), 'state_XYZ');
    expect(result.stateValid).toBe(true);
    expect(result.found).toBe(true);
    expect(result.lastError).toBe(null);
  });

  it('should detect invalid states', () => {
    let result = a.parseRedirectFragment(makeFragment({'_stitch_state': 'state_XYZ'}), 'state_ABC');
    expect(result.stateValid).toBe(false);
    expect(result.lastError).toBe(null);
  });

  it('should detect errors', () => {
    let result = a.parseRedirectFragment(makeFragment({'_stitch_error': 'hello world'}), 'state_ABC');
    expect(result.lastError).toEqual('hello world');
    expect(result.stateValid).toBe(false);
  });

  it('should detect if no items found', () => {
    let result = a.parseRedirectFragment(makeFragment({'foo': 'bar'}), 'state_ABC');
    expect(result.found).toBe(false);
  });

  it('should handle ua redirects', () => {
    let result = a.parseRedirectFragment(makeFragment({'_stitch_ua': 'somejwt$anotherjwt$userid$deviceid'}), 'state_ABC');
    expect(result.found).toBe(true);
    expect(result.ua).toEqual({
      access_token: 'somejwt',
      refresh_token: 'anotherjwt',
      user_id: 'userid',
      device_id: 'deviceid'
    });
  });

  it('should gracefully handle invalid ua data', () => {
    let result = a.parseRedirectFragment(makeFragment({'_stitch_ua': 'invalid'}), 'state_ABC');
    expect(result.found).toBe(false);
    expect(result.ua).toBeNull();
    expect(result.lastError).toBeTruthy();
  });
});

describe('Auth', () => {
  const validUsernames = ['user'];
  let capturedDevice;
  const checkLogin = (url, opts) => {
    const args = JSON.parse(opts.body);

    capturedDevice = args.options.device;
    if (validUsernames.indexOf(args.username) >= 0) {
      return {
        user_id: hexStr,
        device_id: mockDeviceId,
        device: args.options.device
      };
    }

    let body = {error: 'unauthorized', error_code: 'unauthorized'};
    let type = JSONTYPE;
    let status = 401;
    if (args.username === 'html') {
      body = '<html><head><title>Error</title></head><body>Error</body></html>';
      type = 'text/html';
      status = 500;
    }

    return {
      body: body,
      headers: { 'Content-Type': type },
      status: status
    };
  };
  for (const envConfig of envConfigs) {
    describe(envConfig.name, () => { // eslint-disable-line
      beforeEach(() => {
        envConfig.setup();
        fetchMock.post('/auth/providers/local-userpass/login', checkLogin);
        fetchMock.post(DEFAULT_STITCH_SERVER_URL + '/api/client/v2.0/app/testapp/auth/providers/local-userpass/login', checkLogin);
        fetchMock.delete(SESSION_URL, {});
        capturedDevice = undefined;
      });

      afterEach(() => {
        envConfig.teardown();
        fetchMock.restore();
        capturedDevice = undefined;
      });

      it('get() set() clear() authedId() should work', () => {
        expect.assertions(4);
        const a = new Auth(null, '/auth');
        expect(a._get()).toEqual({});

        const testUser = {'access_token': 'bar', 'user_id': hexStr};
        a.set(testUser);
        expect(a._get()).toEqual({'accessToken': 'bar', 'userId': hexStr});
        expect(a.authedId()).toEqual(hexStr);

        a.clear();
        expect(a._get()).toEqual({});
      });

      it('should local auth successfully', () => {
        expect.assertions(1);
        const a = new Auth(null, '/auth');
        return a.provider('userpass').authenticate({ username: 'user', password: 'password' })
          .then(() => expect(a.authedId()).toEqual(hexStr));
      });

      it('should send device info with local auth request', () => {
        expect.assertions(6);
        const a = new Auth(null, '/auth');
        return a.provider('userpass').authenticate({ username: 'user', password: 'password' })
          .then(() => {
            expect('appId' in capturedDevice).toBeTruthy();
            expect('appVersion' in capturedDevice).toBeTruthy();
            expect('platform' in capturedDevice).toBeTruthy();
            expect('platformVersion' in capturedDevice).toBeTruthy();
            expect('sdkVersion' in capturedDevice).toBeTruthy();

            // a new Auth does not have a deviceId to send
            expect('deviceId' in capturedDevice).toBeFalsy();
          });
      });

      it('should set device ID on successful local auth request', () => {
        expect.assertions(2);
        const a = new Auth(null, '/auth');
        expect(a.getDeviceId()).toBeNull();
        return a.provider('userpass').authenticate({ username: 'user', password: 'password' })
          .then(() => expect(a.getDeviceId()).toEqual(mockDeviceId));
      });

      it('should not set device ID on unsuccessful local auth request', () => {
        expect.assertions(1);
        const a = new Auth(null, '/auth');
        return a.provider('userpass').authenticate({ username: 'fake-user', password: 'password' })
          .then(() => console.log('expected error'))
          .catch(() => expect(a.getDeviceId()).toBeNull());
      });

      it('should not clear device id on logout', async() => {
        expect.assertions(3);
        const testClient = new StitchClient('testapp');
        expect(testClient.auth.getDeviceId()).toBeNull();
        return testClient.login('user', 'password')
          .then(() => {
            expect(testClient.auth.getDeviceId()).toEqual(mockDeviceId);
          })
          .then(() => testClient.logout())
          .then(() => {
            expect(testClient.auth.getDeviceId()).toEqual(mockDeviceId);
          });
      });

      it('should send device ID with device info with local auth request on subsequent logins', () => {
        expect.assertions(3);
        const testClient = new StitchClient('testapp');
        expect(testClient.auth.getDeviceId()).toBeNull();
        return testClient.login('user', 'password')
          .then(() => {
            expect(testClient.auth.getDeviceId()).toEqual(mockDeviceId);
          })
          .then(() => testClient.logout())
          .then(() => {
            expect(testClient.auth.getDeviceId()).toEqual(mockDeviceId);
          });
      });

      it('should have an error if local auth is unsuccessful', (done) => {
        expect.assertions(4);
        const a = new Auth(null, '/auth');
        return a.provider('userpass').authenticate({ username: 'fake-user', password: 'password' })
          .then(() => done('expected an error on unsuccessful login'))
          .catch(e => {
            expect(e).toBeInstanceOf(Error);
            expect(e.response.status).toBe(401);
            expect(e.error).toBe('unauthorized');
            expect(e.error_code).toBe('unauthorized');
            done();
          });
      });

      it('should have an error if server returns non-JSON', (done) => {
        expect.assertions(3);
        const a = new Auth(null, '/auth');
        return a.provider('userpass').authenticate({ username: 'html', password: 'password' })
          .then(() => done('expected an error on unsuccessful login'))
          .catch(e => {
            expect(e).toBeInstanceOf(Error);
            expect(e.response.status).toBe(500);
            expect(e.error).toBe('Internal Server Error');
            done();
          });
      });

      it('should allow setting access tokens', () => {
        expect.assertions(3);
        const auth = new Auth(null, '/auth');
        return auth.provider('userpass').authenticate({ username: 'user', password: 'password' })
          .then(() => {
            expect(auth.authedId()).toEqual(hexStr);
            expect(auth.getAccessToken()).toBeUndefined();
            auth.set({'access_token': 'foo'});
            expect(auth.getAccessToken()).toEqual('foo');
          });
      });

      it('should be able to access auth methods from client', () => {
        expect.assertions(4);
        let testClient = new StitchClient('testapp');
        return testClient.login('user', 'password')
          .then(() => {
            expect(testClient.authedId()).toEqual(hexStr);
            expect(testClient.authError()).toBeFalsy();
          })
          .then(() => testClient.logout())
          .then(() => {
            expect(testClient.authedId()).toBeFalsy();
            expect(testClient.authError()).toBeFalsy();
          });
      });
    });
  }
});

describe('http error responses', () => {
  const testErrMsg = 'test: bad request';
  const testErrCode = 'TestBadRequest';
  describe('JSON error responses are handled correctly', () => {
    beforeEach(() => {
      fetchMock.restore();
      fetchMock.post(FUNCTION_CALL_URL, () =>
        ({
          body: {error: testErrMsg, error_code: testErrCode},
          headers: { 'Content-Type': JSONTYPE },
          status: 400
        })
      );
      fetchMock.post(LOCALAUTH_URL, {user_id: hexStr});
    });

    it('should return a StitchError instance with the error and error_code extracted', (done) => {
      const testClient = new StitchClient('testapp');
      return testClient.login('user', 'password')
        .then(() => testClient.executeFunction('testfunc', {items: [{x: {'$oid': hexStr}}]}, 'hello'))
        .catch(e => {
          // This is actually a StitchError, but because there are quirks with
          // transpiling a class that subclasses Error, we can only really
          // check for instanceof Error here.
          expect(e).toBeInstanceOf(Error);
          expect(e.code).toEqual(testErrCode);
          expect(e.message).toEqual(testErrMsg);
          done();
        });
    });
  });
});

describe('anonymous auth', () => {
  beforeEach(() => {
    let count = 0;
    fetchMock.restore();
    fetchMock.mock(`begin:${ANON_AUTH_URL}`, (url, opts) => {
      const parsed = new URL(url, '', true);
      const device = parsed.query ? parsed.query.device : null;

      return {
        user_id: hexStr,
        device_id: mockDeviceId,
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        device: device
      };
    });

    fetchMock.post(FUNCTION_CALL_URL, () => {
      return JSON.stringify({x: ++count});
    });
  });

  it('can authenticate with anonymous auth method', () => {
    expect.assertions(3);
    let testClient = new StitchClient('testapp');
    return testClient.login()
      .then(() => {
        expect(testClient.auth.getAccessToken()).toEqual('test-access-token');
        expect(testClient.authedId()).toEqual(hexStr);
      })
      .then(() => testClient.executeFunction('testfunc', {items: [{x: {'$oid': hexStr}}]}, 'hello'))
      .then((response) => expect(response.x).toEqual(1));
  });
});

describe('api key auth/logout', () => {
  let validAPIKeys = ['valid-api-key'];
  beforeEach(() => {
    let count = 0;
    fetchMock.restore();
    fetchMock.post(APIKEY_AUTH_URL, (url, opts) => {
      if (validAPIKeys.indexOf(JSON.parse(opts.body).key) >= 0) {
        return {
          user_id: hexStr
        };
      }

      return {
        body: {error: 'unauthorized', error_code: 'unauthorized'},
        headers: { 'Content-Type': JSONTYPE },
        status: 401
      };
    });

    fetchMock.post(FUNCTION_CALL_URL, () => {
      return JSON.stringify({x: ++count});
    });
  });

  it('can authenticate with a valid api key', () => {
    expect.assertions(2);
    let testClient = new StitchClient('testapp');
    return testClient.authenticate('apiKey', 'valid-api-key')
      .then(() => expect(testClient.authedId()).toEqual(hexStr))
      .then(() => testClient.executeFunction('testfunc', {items: [{x: 1}]}, 'hello'))
      .then(response => {
        expect(response.x).toEqual(1);
      });
  });

  it('gets a rejected promise if using an invalid API key', (done) => {
    expect.assertions(3);
    let testClient = new StitchClient('testapp');
    return testClient.authenticate('apiKey', 'INVALID_KEY')
      .then(() => {
        done('Error should have been thrown, but was not');
      })
      .catch(e => {
        expect(e).toBeInstanceOf(Error);
        expect(e.response.status).toBe(401);
        expect(e.error).toBe('unauthorized');
        done();
      });
  });
});

describe('login/logout', () => {
  for (const envConfig of envConfigs) {
    describe(envConfig.name, () => {
      const testOriginalRefreshToken = 'original-refresh-token';
      const testOriginalAccessToken = 'original-access-token';
      let validAccessTokens = [testOriginalAccessToken];
      let count = 0;
      beforeEach(() => {
        fetchMock.restore();
        fetchMock.get(PROFILE_URL, () => sampleProfile);
        fetchMock.post(LOCALAUTH_URL, {
          user_id: hexStr,
          refresh_token: testOriginalRefreshToken,
          access_token: testOriginalAccessToken
        });

        fetchMock.post(FUNCTION_CALL_URL, (url, opts) => {
          const providedToken = opts.headers['Authorization'].split(' ')[1];
          if (validAccessTokens.indexOf(providedToken) >= 0) {
            // provided access token is valid
            return {x: ++count};
          }

          return {
            body: {error: 'invalid session', error_code: 'InvalidSession'},
            headers: { 'Content-Type': JSONTYPE },
            status: 401
          };
        });

        fetchMock.post(SESSION_URL, (url, opts) => {
          let accessToken = Math.random().toString(36).substring(7);
          validAccessTokens.push(accessToken);
          return {access_token: accessToken};
        });
      });

      it('stores the refresh token after logging in', () => {
        expect.assertions(3);
        let testClient = new StitchClient('testapp');
        return testClient.login('user', 'password')
          .then(() => {
            let storedToken = testClient.auth.storage.get(REFRESH_TOKEN_KEY);
            expect(storedToken).toEqual(testOriginalRefreshToken);
            expect(testClient.auth.getAccessToken()).toEqual(testOriginalAccessToken);
            expect(testClient.authedId()).toEqual(hexStr);
          });
      });

      it('can get a user profile', () => {
        let testClient = new StitchClient('testapp');
        return testClient.login('user', 'password')
          .then(() => testClient.userProfile())
          .then(response => {
            expect(response).toEqual(sampleProfile);
          });
      });

      it('fetches a new access token if InvalidSession is received', () => {
        expect.assertions(4);
        let testClient = new StitchClient('testapp');
        return testClient.login('user', 'password')
          .then(() => testClient.executeFunction('testfunc', {items: [{x: 1}]}, 'hello'))
          .then(response => {
            // first request (token is still valid) should yield the response we expect
            expect(response.x).toEqual(1);
          })
          .then(() => {
            // invalidate the access token. This forces the client to exchange for a new one.
            validAccessTokens = [];
            return testClient.executeFunction('testfunc', {items: [{x: 1}]}, 'hello');
          })
          .then(response => {
            expect(response.x).toEqual(2);
          })
          .then(() => {
            expect(testClient.auth.getAccessToken()).toEqual(validAccessTokens[0]);
          })
          .then(() => {
            testClient.auth.storage.clear();
            expect(testClient.authedId()).toBeFalsy();
          });
      });
    });
  }
});

describe('proactive token refresh', () => {
  // access token with 5138-Nov-16 expiration
  const testUnexpiredAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoidGVzdC1hY2Nlc3MtdG9rZW4iLCJleHAiOjEwMDAwMDAwMDAwMH0.KMAoJOX8Dh9wvt-XzrUN_W6fnypsPrlu4e-AOyqSAGw';

  // acesss token with 1970-Jan-01 expiration
  const testExpiredAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoidGVzdC1hY2Nlc3MtdG9rZW4iLCJleHAiOjF9.7tOdF0LXC_2iQMjNfZvQwwfLNiEj-dd0VT0adP5bpjo';

  let validAccessTokens = [testUnexpiredAccessToken];
  let count = 0;
  let refreshCount = 0;

  beforeEach(() => {
    fetchMock.restore();

    fetchMock.post(FUNCTION_CALL_URL, (url, opts) => {
      const providedToken = opts.headers['Authorization'].split(' ')[1];
      if (validAccessTokens.indexOf(providedToken) >= 0) {
        // provided access token is valid
        return JSON.stringify({x: ++count});
      }

      throw new Error('invalid session would have been returned from server.');
    });

    count = 0;
    refreshCount = 0;

    fetchMock.post(SESSION_URL, (url, opts) => {
      ++refreshCount;
      return {access_token: testUnexpiredAccessToken};
    });
  });

  it('proactively fetches a new access token if the locally stored token is expired', () => {
    expect.assertions(5);

    fetchMock.post(LOCALAUTH_URL, {
      user_id: hexStr,
      refresh_token: 'refresh-token',
      access_token: testExpiredAccessToken
    });

    let testClient = new StitchClient('testapp');
    return testClient.login('user', 'password')
      .then(() => {
        // make sure we are starting with the expired access token
        expect(testClient.auth.getAccessToken()).toEqual(testExpiredAccessToken);
        return testClient.executeFunction('testfunc', {items: [{x: 1}]}, 'hello');
      })
      .then(response => {
        // token was expired, though it should yield the response we expect without throwing InvalidSession
        expect(response.x).toEqual(1);
      })
      .then(() => {
        // make sure token was updated
        expect(refreshCount).toEqual(1);
        expect(testClient.auth.getAccessToken()).toEqual(testUnexpiredAccessToken);
      })
      .then(() => {
        testClient.auth.storage.clear();
        expect(testClient.authedId()).toBeFalsy();
      });
  });

  it('does not fetch a new access token if the locally stored token is not expired/expiring', () => {
    expect.assertions(5);

    fetchMock.post(LOCALAUTH_URL, {
      user_id: hexStr,
      refresh_token: 'refresh-token',
      access_token: testUnexpiredAccessToken
    });

    let testClient = new StitchClient('testapp');
    return testClient.login('user', 'password')
      .then(() => {
        // make sure we are starting with the unexpired access token
        expect(testClient.auth.getAccessToken()).toEqual(testUnexpiredAccessToken);
        return testClient.executeFunction('testfunc', {items: [{x: 1}]}, 'hello');
      })
      .then(response => {
        expect(response.x).toEqual(1);
      })
      .then(() => {
        // make sure token was not updated
        expect(refreshCount).toEqual(0);
        expect(testClient.auth.getAccessToken()).toEqual(testUnexpiredAccessToken);
      })
      .then(() => {
        testClient.auth.storage.clear();
        expect(testClient.authedId()).toBeFalsy();
      });
  });
});

describe('client options', () => {
  beforeEach(() => {
    fetchMock.restore();
    fetchMock.post('https://stitch2.mongodb.com/api/client/v2.0/app/testapp/auth/providers/local-userpass/login', {user_id: hexStr});
    fetchMock.post('https://stitch2.mongodb.com/api/client/v2.0/app/testapp/functions/call', (url, opts) => {
      return {x: {'$oid': hexStr}};
    });
    fetchMock.delete(SESSION_URL, {});
    fetchMock.post(FUNCTION_CALL_URL, () => {
      return JSON.stringify({x: {'$oid': hexStr}});
    });
  });

  it('allows overriding the base url', () => {
    let testClient = new StitchClient('testapp', {baseUrl: 'https://stitch2.mongodb.com'});
    expect.assertions(1);
    return testClient.login('user', 'password')
      .then(() => {
        return testClient.executeFunction('testfunc', {items: [{x: {'$oid': hexStr}}]}, 'hello');
      })
      .then((response) => {
        expect(response.x).toEqual(new ExtJSON.BSON.ObjectID(hexStr));
      });
  });

  it('returns a rejected promise if trying to execute a pipeline without auth', (done) => {
    let testClient = new StitchClient('testapp');
    testClient.logout()
      .then(() => testClient.executeFunction('testfunc', {items: [{x: {'$oid': hexStr}}]}, 'hello'))
      .then(() => {
        done(new Error('Error should have been triggered, but was not'));
      })
      .catch((e) => {
        done();
      });
  });
});

describe('function execution', () => {
  for (const envConfig of envConfigs) {
    describe(envConfig.name, () => {
      beforeAll(envConfig.setup);
      afterAll(envConfig.teardown);
      describe(envConfig.name + ' extended json decode (incoming)', () => {
        beforeAll(() => {
          fetchMock.restore();
          fetchMock.post(LOCALAUTH_URL, {user_id: '5899445b275d3ebe8f2ab8a6'});
          fetchMock.post(FUNCTION_CALL_URL, () => {
            return JSON.stringify({x: {'$oid': hexStr}});
          });
        });

        it('should decode extended json from function responses', () => {
          expect.assertions(1);
          let testClient = new StitchClient('testapp');
          return testClient.login('user', 'password')
            .then(() => testClient.executeFunction('testfunc', {items: [{x: {'$oid': hexStr}}]}, 'hello'))
            .then((response) => expect(response.x).toEqual(new ExtJSON.BSON.ObjectID(hexStr)));
        });
      });

      describe('extended json encode (outgoing)', () => {
        let requestArg;
        beforeAll(() => {
          fetchMock.restore();
          fetchMock.post(LOCALAUTH_URL, {user_id: hexStr});
          fetchMock.post(FUNCTION_CALL_URL, (name, arg1) => {
            requestArg = arg1;
            return {x: {'$oid': hexStr}};
          });
        });

        it('should encode objects to extended json for outgoing function request body', () => {
          expect.assertions(1);
          let testClient = new StitchClient('testapp', {baseUrl: ''});
          return testClient.login('user', 'password')
            .then(() => testClient.executeFunction('testfunc', {x: new ExtJSON.BSON.ObjectID(hexStr)}, 'hello'))
            .then(response => expect(JSON.parse(requestArg.body)).toEqual({name: 'testfunc', arguments: [{x: {'$oid': hexStr}}, 'hello']}));
        });
      });

      describe('non 2xx is returned', () => {
        beforeAll(() => {
          fetchMock.restore();
          fetchMock.post(LOCALAUTH_URL, {user_id: hexStr});
          fetchMock.post(FUNCTION_CALL_URL, (name, arg1, arg2) => {
            return {
              body: {error: 'bad request'},
              headers: { 'Content-Type': JSONTYPE },
              status: 400
            };
          });
        });

        it('promise should be rejected', () => {
          expect.assertions(2);
          let testClient = new StitchClient('testapp', {baseUrl: ''});
          return testClient.login('user', 'password')
            .then(() => testClient.executeFunction('testfunc', {x: new ExtJSON.BSON.ObjectID(hexStr)}, 'hello'))
            .catch(e => {
              expect(e).toBeInstanceOf(Error);
              expect(e.response.status).toBe(400);
            });
        });
      });
    });
  }
});
