package main

import (
	"fmt"
	"os"
	"runtime"
	"syscall"

	"golang.org/x/sys/unix"
)

func setupRuntime(public, data string, checkPublic bool) error {
	identity, err := runtimeIdentityFor(containerIdentity, os.Getenv, os.Geteuid(), os.Getegid())
	if err != nil || !identity.Enabled {
		return err
	}
	if os.Geteuid() != 0 && (os.Geteuid() != identity.UID || os.Getegid() != identity.GID) {
		return fmt.Errorf("PUID/PGID request %d:%d but Docker user: runs as %d:%d; use one matching identity or omit PUID/PGID when using user:", identity.UID, identity.GID, os.Geteuid(), os.Getegid())
	}
	directory, err := separateRuntimeDirectories(public, data)
	if err != nil {
		return err
	}
	if os.Geteuid() == 0 {
		// Do not alter any state if the container cannot drop its root identity.
		header := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
		var caps [2]unix.CapUserData
		if err := unix.Capget(&header, &caps[0]); err != nil {
			return err
		}
		needed := uint32(1<<unix.CAP_SETUID | 1<<unix.CAP_SETGID)
		if caps[0].Effective&needed != needed {
			return fmt.Errorf("PUID/PGID initialization requires SETUID and SETGID capabilities; with cap_drop: [ALL], add CHOWN, DAC_OVERRIDE, FOWNER, SETUID and SETGID, or start directly with Docker user:")
		}
		mounts, err := os.ReadFile("/proc/self/mountinfo")
		if err != nil {
			return fmt.Errorf("inspect private data mounts: %w", err)
		}
		if err := rejectNestedDataMounts(directory, string(mounts)); err != nil {
			return err
		}
		if err := prepareRuntimeData(directory, identity.UID, identity.GID); err != nil {
			return fmt.Errorf("initialize private data directory %s for UID=%d GID=%d: %w", directory, identity.UID, identity.GID, err)
		}
		return execRuntimeIdentity(identity)
	}
	if err := hardenNonrootRuntime(); err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return fmt.Errorf("data directory %s is not writable by UID=%d GID=%d: %w", directory, identity.UID, identity.GID, err)
	}
	if checkPublic {
		if err := unix.Faccessat(unix.AT_FDCWD, public, unix.R_OK|unix.X_OK, unix.AT_EACCESS); err != nil {
			return fmt.Errorf("public directory %s is not readable/traversable by UID=%d GID=%d: %w; set PUID/PGID to a NAS account with read/search permission and keep the public mount read-only", public, identity.UID, identity.GID, err)
		}
	}
	probe, err := os.CreateTemp(directory, ".lantern-permission-")
	if err != nil {
		return fmt.Errorf("data directory %s is not writable by UID=%d GID=%d: %w; allow this NAS account to write it, or use the image's root initialization with PUID/PGID", directory, identity.UID, identity.GID, err)
	}
	name := probe.Name()
	if err := probe.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Remove(name); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "LanternDock runtime UID=%d GID=%d; private data %s\n", identity.UID, identity.GID, directory)
	return nil
}

func execRuntimeIdentity(identity runtimeIdentity) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	groups, err := syscall.Getgroups()
	if err != nil {
		return err
	}
	var extra []int
	for _, group := range groups {
		if group != 0 {
			extra = append(extra, group)
		}
	}
	// Re-exec on this thread after dropping identity/capabilities so every new
	// runtime thread inherits no-new-privileges and no root credentials.
	runtime.LockOSThread()
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return err
	}
	if err := unix.Prctl(unix.PR_SET_KEEPCAPS, 0, 0, 0, 0); err != nil {
		return err
	}
	if err := syscall.Setgroups(extra); err != nil {
		return fmt.Errorf("drop supplementary root groups: %w", err)
	}
	if err := syscall.Setresgid(identity.GID, identity.GID, identity.GID); err != nil {
		return fmt.Errorf("set PGID: %w", err)
	}
	if err := syscall.Setresuid(identity.UID, identity.UID, identity.UID); err != nil {
		return fmt.Errorf("set PUID: %w", err)
	}
	return execWithoutCapabilities(executable)
}

func hardenNonrootRuntime() error {
	header := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var caps [2]unix.CapUserData
	if err := unix.Capget(&header, &caps[0]); err != nil {
		return err
	}
	noNewPrivileges, err := unix.PrctlRetInt(unix.PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0)
	if err != nil {
		return err
	}
	if noNewPrivileges == 1 && caps == [2]unix.CapUserData{} {
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	runtime.LockOSThread()
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return err
	}
	return execWithoutCapabilities(executable)
}

func execWithoutCapabilities(executable string) error {
	header := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var empty [2]unix.CapUserData
	if err := unix.Capset(&header, &empty[0]); err != nil {
		return fmt.Errorf("clear runtime capabilities: %w", err)
	}
	if err := syscall.Exec(executable, os.Args, os.Environ()); err != nil {
		return fmt.Errorf("start non-root runtime: %w", err)
	}
	return nil
}
