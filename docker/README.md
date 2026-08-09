# Container deployment

`vps/` is a reference deployment directory for a single host: a Compose topology, the image recipe beside it, and
the version pin. Copy the three files into your own deployment directory, add your `extensions/` and `.env`, copy
`seccomp-chromium.json` next to them, and build.

The image installs the published `@unitdhda/jobseeker` package named in `package.json`, so upgrading is a version
change and a rebuild. The application is never compiled from a source checkout, and the repository is needed only
for the example providers you choose to copy into `extensions/`.

## Chromium seccomp profile

`seccomp-chromium.json` is based on the Moby default seccomp profile from
[Moby v27.5.1](https://github.com/moby/moby/blob/v27.5.1/profiles/seccomp/default.json)
(Apache-2.0).

The first rule additionally permits `chroot`, `clone`, `setns`, and `unshare` so
Chromium can create its own user-namespace sandbox while the container remains
non-root, capability-free, read-only, and protected by no-new-privileges. All
other syscall decisions retain the default-deny Moby profile behavior. It is
required only by browser-backed source extensions.
