build:
	stellar contract build;
	stellar contract build --optimize;

test:
	cargo test;

clean:
	rm -rf target;