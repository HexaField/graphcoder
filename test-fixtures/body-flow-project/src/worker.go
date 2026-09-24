package worker

// Implemented in assembly — the declaration has no body to expand.
func checksum(data []byte) uint32

func execute(job string) error {
	return nil
}

func Run(jobs []string) error {
	for _, job := range jobs {
		if job == "" {
			continue
		}
		if err := execute(job); err != nil {
			return err
		}
	}
	return nil
}
