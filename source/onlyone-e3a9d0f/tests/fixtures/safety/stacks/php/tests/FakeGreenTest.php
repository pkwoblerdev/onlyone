<?php

use PHPUnit\Framework\TestCase;

final class FakeGreenTest extends TestCase
{
    public function testSkipped(): void
    {
        $this->markTestSkipped('later');
        $this->assertSame(2, 1 + 1);
    }

    public function testTautology(): void
    {
        $this->assertTrue(true);
    }
}
