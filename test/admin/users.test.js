const StitchMongoFixture = require('../fixtures/stitch_mongo_fixture');

import { buildAdminTestHarness, extractTestFixtureDataPoints } from '../testutil';


describe('Users', ()=>{
  let test = new StitchMongoFixture();
  let th;
  let appUsers;

  beforeAll(() => test.setup());
  afterAll(() => test.teardown());

  beforeEach(async() => {
    const { apiKey, groupId, serverUrl } = extractTestFixtureDataPoints(test);
    th = await buildAdminTestHarness(true, apiKey, groupId, serverUrl);
    appUsers = th.app().users();

    const newProvider = await th.configureUserpass();
    expect(newProvider.type).toEqual('local-userpass');
    expect(newProvider.name).toEqual('local-userpass');
    expect(newProvider.config).toBeUndefined();
  });

  afterEach(async() => th.cleanup());

  it('listing apps should return empty list', async() => {
    let users = await appUsers.list();
    expect(users).toEqual([]);
  });

  const testUserName = 'testusername@test.com';
  /** @returns {Object} user */
  async function createUserWithExpectation() {
    let users = await appUsers.list();
    expect(users).toEqual([]);
    await appUsers.create({email: testUserName, password: 'admin123'});
    users = await appUsers.list();
    expect(users).toHaveLength(1);
    expect(users[0].data.email).toEqual(testUserName);
    return users[0];
  }
  /** @returns {Object} user */
  async function fetchUserByIdWithExpectation() {
    let createdUser = await createUserWithExpectation();
    let fetchedUser = await appUsers.user(createdUser._id).get();
    expect(fetchedUser._id).toEqual(createdUser._id);
    expect(fetchedUser.data).toEqual(createdUser.data);
    expect(fetchedUser.identities).toEqual(createdUser.identities);
    expect(fetchedUser.type).toEqual(createdUser.type);
    return fetchedUser;
  }
  it('creating user should make it appear in list', async() => {
    await createUserWithExpectation();
  });

  it('can fetch a user by id', async() => {
    await fetchUserByIdWithExpectation();
  });

  it('can remove a user by id', async() => {
    let user = await fetchUserByIdWithExpectation();
    await appUsers.user(user._id).remove();
    let users = await appUsers.list();
    expect(users).toHaveLength(0);
  });
});
