# Tesla Fleet API — the question to ask, with the evidence already gathered

Everything below was measured on 2026-09-10. Paste it into Tesla's business
support (the **Support** item in the left nav of business.tesla.com, or the
developer-console contact route). It is written so nobody has to re-measure
anything to answer it.

---

**Subject:** Fleet API returns zero vehicles for a business fleet — application
registered under a personal account?

We operate a fleet of 82 Teslas (72 Model Y, 10 Model 3) in the UAE, held in
the Tesla Business account **Ecosine Transports LLC**. We have built a Fleet API
integration and cannot see any vehicles.

**What works**

- The application is registered: `GET /api/1/partner_accounts/public_key`
  returns our public key for the domain
  `fleet-dashboard-wpeqb.ondigitalocean.app`.
- A third-party token (authorization_code, a person signs in) is issued and
  accepted by the API.
- A partner token (client_credentials) is issued and accepted by the API.
- Region is correct — the NA host returns "user out of region, use
  https://fleet-api.prd.eu.vn.cloud.tesla.com".

**What does not**

`GET /api/1/vehicles` returns **HTTP 200 with an empty array** on BOTH token
types.

**The account situation, stated precisely**

The Tesla account `mamoon@egari.ae` is a member of the Business account
**Ecosine Transports LLC** with the role **Fleet Manager**, and the same
account owns the developer application. So this is not an application sitting
outside the business.

Both tokens nevertheless carry `"account_type": "person"` — including the
partner token, which represents the application itself and involves no human
login at all:

```
sub           9cafefcf-37b1-4c49-8735-3112f8cf1db8
gty           client-credentials
account_type  person
```

In the business portal, the vehicles appear under **Owned Vehicles** (owned by
the business, not by any individual), and the **Vehicle Management** column is
empty for every one of the 82 cars.

**Our questions**

1. What populates the **Vehicle Management** column on the Fleet page, and is
   that the mechanism by which a business attaches an application to its
   vehicles? It is empty for all 82 of ours.
2. Does a **Fleet Manager** have the authority to make that association, or
   must it be an Owner or Admin of the business account?
3. Is there a fleet-level grant — selecting all vehicles and authorising an
   application once — as opposed to virtual-key pairing on each of 82 cars
   individually? Model 3 and Model Y both require the Vehicle Command Protocol,
   so per-car pairing cannot be automated for any of our fleet.
4. Should we be using "Third-party for Business" tokens, and if so what is the
   flow? Your documentation names the token type but never describes how a
   business authorises an application.
5. Why does a `client_credentials` partner token for an application owned by a
   business member report `"account_type": "person"`? If that is expected, what
   distinguishes a token that can see business-owned vehicles?

**A separate, smaller issue on the same integration**

Your auth edge refuses our server's network. `POST` to
`fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token` **and** to
`auth.tesla.com/oauth2/v3/token` both return HTTP 403 with an Akamai "Access
Denied" page, from a DigitalOcean range, while the identical request from
another network reaches OAuth normally. Recent references:

```
#18.ccd5ce17.1789035013.1637d0b9
#18.dbd5ce17.1789038325.1b3bb33d
#18.d967cd17.1789039363.18ddf9      (tesla.com/_ak/... , same block)
```

The egress address changes per deployment (164.92.186.179, 165.232.77.209,
165.22.66.25 observed), so an allowlist for a single IP would not hold. The
**data** host `fleet-api.prd.eu.vn.cloud.tesla.com` answers this same network
normally — only the auth hosts refuse it.

Can DigitalOcean ranges be allowed for the auth hosts, or is there a supported
pattern for API clients hosted on cloud infrastructure?
