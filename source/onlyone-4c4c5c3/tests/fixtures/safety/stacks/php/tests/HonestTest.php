<?php

use PHPUnit\Framework\TestCase;

final class HonestTest extends TestCase
{
    public function testAdds(): void
    {
        $this->assertSame(2, 1 + 1);
    }

    public function testDiffers(): void
    {
        $this->assertNotSame('a', 'b');
    }
}
