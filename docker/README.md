# Chromium seccomp profile

`seccomp-chromium.json` is based on the Moby default seccomp profile from
[Moby v27.5.1](https://github.com/moby/moby/blob/v27.5.1/profiles/seccomp/default.json)
(Apache-2.0).

The first rule additionally permits `chroot`, `clone`, `setns`, and `unshare` so
Chromium can create its own user-namespace sandbox while the container remains
non-root, capability-free, read-only, and protected by no-new-privileges. All
other syscall decisions retain the default-deny Moby profile behavior.
