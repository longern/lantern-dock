//go:build !linux

package main

import "fmt"

func setupRuntime(public, data string, checkPublic bool) error {
	if containerIdentity != "" {
		return fmt.Errorf("container identity initialization requires Linux")
	}
	return nil
}
