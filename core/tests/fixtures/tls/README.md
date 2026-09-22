# TLS fixtures

A self-signed P-256 certificate for `www.example.edu` and `lab.example.edu`, valid until 2036, with
its key. Generated once with `openssl req -x509 -newkey ec`.

It exists so the certificate store's parsing is tested against a real X.509 rather than a string
that happens to look like one. `expiryOf` reads `notAfter` from the certificate itself, and a test
that fed it a hand-written stub would not have exercised the parser at all.

The key is a throwaway for a name nobody owns. It signs nothing outside this directory.
