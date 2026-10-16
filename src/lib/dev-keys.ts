/**
 * Dev-only Ed25519 key for the seeded shopper bot.
 * Not a production secret. Production bots register their own public key.
 */
export const DEV_BOT_TOKEN = "mv_test_jp_9f3c1a7b";

export const DEV_SHOPPER = {
  email: "jp@mercavine.test",
  password: "shelf-demo-2026",
  name: "Jordan Pike",
  displayName: "JP",
};

export const DEV_OTHER_SHOPPER = {
  email: "sam@mercavine.test",
  password: "shelf-demo-2026",
  name: "Sam Okonkwo",
  displayName: "Sam",
};

export const DEV_BOT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATcDjCsI1HNydGZDvFEo+q3iiWRdEx75093BEgJf27c0=
-----END PUBLIC KEY-----
`;

export const DEV_BOT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKuKQeaF6xzvPIW3RQf6njcZA+gDu26jikT2cvzGB9E6
-----END PRIVATE KEY-----
`;
